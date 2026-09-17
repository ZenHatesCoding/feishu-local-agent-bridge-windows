import type { NormalizedMessage } from '@larksuite/channel';
import { CollaborationClient } from './client';
import { stripTargetMentionPrefix } from './mentions';
import type { AgentIdentity, Dispatch } from './types';
import type { AgentRegistration } from './types';
import type { NormalizedAttachment } from '../media/attachment';
import { snapshotArtifact } from './artifact-store';
import { taskIdFor } from './task-id';
import { parseAgentRoster, resolveMentionedAgents } from './agent-roster';

export interface BridgeCollaborationDecision {
  managed: boolean;
  respond: boolean;
  promptContext?: string;
  taskId?: string;
  dispatchId?: string;
  reason?: string;
}

export interface CollaborationHandoffIntent {
  targetAgentId: string;
  content: string;
}

export interface CollaborationReplyIntent {
  targetAgentId: string;
  content: string;
}

export interface CollaborationAskIntent {
  targetAgentId: string;
  content: string;
}

export function extractCollaborationHandoff(content: string): {
  visibleContent: string;
  handoff?: CollaborationHandoffIntent;
  reply?: CollaborationReplyIntent;
  ask?: CollaborationAskIntent;
} {
  const match = /<collaboration_(handoff|reply|ask)\s+target="([a-z0-9_-]+)">\s*([\s\S]*?)\s*<\/collaboration_\1>/i.exec(content);
  if (!match) return { visibleContent: content };
  const kind = match[1]!.toLocaleLowerCase();
  const targetAgentId = match[2]!.trim();
  const intentContent = match[3]!.trim();
  return {
    visibleContent: `${content.slice(0, match.index)}${content.slice(match.index + match[0].length)}`.trim(),
    ...(targetAgentId && intentContent
      ? kind === 'handoff'
        ? { handoff: { targetAgentId, content: intentContent } }
        : kind === 'ask'
          ? { ask: { targetAgentId, content: intentContent } }
          : { reply: { targetAgentId, content: intentContent } }
      : {}),
  };
}

export class BridgeCollaborationAdapter {
  constructor(
    private readonly client: CollaborationClient,
    private readonly agentId: string,
    private readonly tenantKey: string,
    private readonly eventSource: 'distributed' | 'coordinator' = 'distributed',
    private readonly artifactRoot?: string,
    private readonly agentRoster: AgentRegistration[] = [],
  ) {}

  registerIdentity(openId: string): Promise<void> {
    return this.client.registerIdentity(this.agentId, openId, {
      ...(process.env.LARK_COLLAB_NODE_ID ? { nodeId: process.env.LARK_COLLAB_NODE_ID } : {}),
      ...(process.env.LARK_COLLAB_INSTANCE_ID ? { instanceId: process.env.LARK_COLLAB_INSTANCE_ID } : {}),
      ...(process.env.npm_package_version ? { version: process.env.npm_package_version } : {}),
    }).then(() => undefined);
  }

  async intake(msg: NormalizedMessage): Promise<BridgeCollaborationDecision> {
    if (msg.chatType === 'p2p' || !msg.threadId) return { managed: false, respond: true };
    const actorType = senderTypeOf(msg);
    if (this.eventSource === 'coordinator') {
      const taskId = taskIdFor({ tenantKey: this.tenantKey, chatId: msg.chatId, threadId: msg.threadId });
      const dispatch = await this.waitForDispatch(taskId);
      if (!dispatch) {
        return { managed: true, respond: false, taskId, reason: 'coordinator has no authorized dispatch' };
      }
      return this.acceptDispatch(msg, taskId, dispatch);
    }
    const result = await this.client.submit({
      type: 'message',
      idempotencyKey: `feishu-message:${msg.messageId}`,
      address: { tenantKey: this.tenantKey, chatId: msg.chatId, threadId: msg.threadId },
      messageId: msg.messageId,
      actor: {
        type: actorType,
        id: msg.senderId,
        ...(msg.senderName ? { name: msg.senderName } : {}),
      },
      content: msg.content || '(empty message)',
      targetAgentIds: actorType === 'human' ? this.observedHumanTargets(msg) : [],
    });

    let dispatch = result.dispatches.find((item) => item.targetAgentId === this.agentId);
    if (!dispatch && actorType === 'agent') {
      const pending = await this.client.dispatches(this.agentId);
      dispatch = latestPendingForTask(pending.dispatches, result.task.id);
    }
    if (!dispatch) {
      return {
        managed: true,
        respond: false,
        taskId: result.task.id,
        reason: actorType === 'agent' ? 'agent mention has no authorized dispatch' : 'agent was not routed',
      };
    }

    return this.acceptDispatch(msg, result.task.id, dispatch);
  }

  async finishRun(
    taskId: string,
    content: string,
    runId: string,
    dispatchId: string,
    success: boolean,
  ): Promise<void> {
    try {
      if (success && content.trim()) {
        await this.client.submit({
          type: 'return',
          idempotencyKey: `agent-result:${this.agentId}:${runId}`,
          taskId,
          actorAgentId: this.agentId,
          causedByDispatchId: dispatchId,
          content,
        });
      }
      await this.client.acknowledge(dispatchId, {
        agentId: this.agentId,
        status: success ? 'completed' : 'failed',
        idempotencyKey: `${success ? 'complete' : 'fail'}:${dispatchId}:${runId}`,
      });
    } catch (err) {
      if (success) {
        await this.client.acknowledge(dispatchId, {
          agentId: this.agentId,
          status: 'failed',
          idempotencyKey: `fail:${dispatchId}:${runId}`,
        }).catch(() => undefined);
      }
      throw err;
    }
  }

  async createHandoff(input: {
    taskId: string;
    dispatchId: string;
    targetAgentId: string;
    content: string;
    runId: string;
  }): Promise<AgentIdentity & { content: string }> {
    return this.createDelegation('handoff', input);
  }

  async createReply(input: {
    taskId: string;
    dispatchId: string;
    targetAgentId: string;
    content: string;
    runId: string;
  }): Promise<AgentIdentity & { content: string }> {
    return this.createDelegation('reply', input);
  }

  async createAsk(input: {
    taskId: string;
    dispatchId: string;
    targetAgentId: string;
    content: string;
    runId: string;
  }): Promise<AgentIdentity & { content: string }> {
    return this.createDelegation('ask', input);
  }

  private async createDelegation(
    type: 'reply' | 'handoff' | 'ask',
    input: { taskId: string; dispatchId: string; targetAgentId: string; content: string; runId: string },
  ): Promise<AgentIdentity & { content: string }> {
    const identity = (await this.client.identities()).agents
      .find((agent) => agent.id === input.targetAgentId);
    if (!identity) throw new Error(`target agent has not registered its Feishu identity: ${input.targetAgentId}`);
    const content = stripTargetMentionPrefix(input.content, identity);
    await this.client.submit({
      type,
      idempotencyKey: `bridge-${type}:${this.agentId}:${input.runId}:${input.targetAgentId}`,
      taskId: input.taskId,
      actorAgentId: this.agentId,
      causedByDispatchId: input.dispatchId,
      targetAgentId: input.targetAgentId,
      content,
    });
    return { ...identity, content };
  }
  async recordAttachments(taskId: string, attachments: readonly NormalizedAttachment[]): Promise<void> {
    if (!this.artifactRoot) return;
    for (const attachment of attachments) {
      if (attachment.decision !== 'accepted') continue;
      const artifact = await snapshotArtifact({
        sourcePath: attachment.absPath,
        root: this.artifactRoot,
        taskId,
        originalName: attachment.originalName,
        kind: attachment.kind,
        mime: attachment.mime,
        sourceMessageId: attachment.sourceMessageId,
        sourceFileKey: attachment.sourceFileKey,
      });
      await this.client.submit({
        type: 'artifact',
        idempotencyKey: `artifact-inbound:${taskId}:${artifact.id}`,
        taskId,
        actorAgentId: this.agentId,
        artifact,
      });
    }
  }

  private async waitForDispatch(taskId: string): Promise<Dispatch | undefined> {
    const rawWaitMs = Number(process.env.LARK_COLLAB_DISPATCH_WAIT_MS ?? 10_000);
    const waitMs = Number.isFinite(rawWaitMs) && rawWaitMs >= 0 ? rawWaitMs : 10_000;
    const deadline = Date.now() + waitMs;
    let delayMs = 100;
    do {
      const pending = await this.client.dispatches(this.agentId);
      const dispatch = latestPendingForTask(pending.dispatches, taskId);
      if (dispatch) return dispatch;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remaining)));
      delayMs = Math.min(Math.round(delayMs * 1.5), 1_000);
    } while (Date.now() <= deadline);
    return undefined;
  }

  private observedHumanTargets(msg: NormalizedMessage): string[] {
    // Every delivery of a Feishu rich-text message carries its entire
    // structured mention list.  Preserve that source fact instead of reducing
    // it to the receiving bridge.  The self fallback keeps older SDK payloads
    // compatible while preventing an unmentioned bridge from inventing work.
    const targets = new Set(resolveMentionedAgents(msg, this.agentRoster));
    if (msg.mentionedBot) targets.add(this.agentId);
    return [...targets];
  }

  private async acceptDispatch(
    msg: NormalizedMessage,
    taskId: string,
    dispatch: Dispatch,
  ): Promise<BridgeCollaborationDecision> {
    const context = await this.client.promptContext(taskId, this.agentId, dispatch.id);
    await this.client.acknowledge(dispatch.id, {
      agentId: this.agentId,
      status: 'accepted',
      idempotencyKey: `accept:${dispatch.id}:${msg.messageId}`,
    });
    return {
      managed: true,
      respond: true,
      promptContext: context.promptContext,
      taskId,
      dispatchId: dispatch.id,
    };
  }
}

export function bridgeCollaborationFromEnv(): BridgeCollaborationAdapter | undefined {
  const url = process.env.LARK_COLLAB_HUB_URL;
  const token = process.env.LARK_COLLAB_HUB_TOKEN;
  const agentId = process.env.LARK_COLLAB_AGENT_ID;
  const tenantKey = process.env.LARK_COLLAB_TENANT_KEY;
  const eventSource = process.env.LARK_COLLAB_EVENT_SOURCE ?? 'distributed';
  const values = [url, token, agentId, tenantKey];
  if (values.every((value) => !value)) return undefined;
  if (values.some((value) => !value)) {
    throw new Error(
      'collaboration mode requires LARK_COLLAB_HUB_URL, LARK_COLLAB_HUB_TOKEN, ' +
      'LARK_COLLAB_AGENT_ID, and LARK_COLLAB_TENANT_KEY',
    );
  }
  if (eventSource !== 'distributed' && eventSource !== 'coordinator') {
    throw new Error('LARK_COLLAB_EVENT_SOURCE must be distributed or coordinator');
  }
  return new BridgeCollaborationAdapter(
    new CollaborationClient({ baseUrl: url!, token: token! }),
    agentId!,
    tenantKey!,
    eventSource,
    process.env.LARK_COLLAB_ARTIFACT_ROOT,
    parseAgentRoster(process.env.LARK_COLLAB_AGENT_ROSTER),
  );
}

function senderTypeOf(msg: NormalizedMessage): 'human' | 'agent' {
  const raw = msg.raw as { sender?: { sender_type?: unknown } } | undefined;
  const type = raw?.sender?.sender_type;
  return type === 'app' || type === 'bot' ? 'agent' : 'human';
}

function latestPendingForTask(dispatches: Dispatch[], taskId: string): Dispatch | undefined {
  return dispatches
    .filter((item) => item.taskId === taskId && item.status === 'pending')
    .sort((a, b) => b.sequence - a.sequence)[0];
}
