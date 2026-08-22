import type { NormalizedMessage } from '@larksuite/channel';
import { buildCollaborationContext } from './context';
import { CollaborationClient } from './client';
import type { Dispatch } from './types';
import { taskIdFor } from './task-id';

export interface BridgeCollaborationDecision {
  managed: boolean;
  respond: boolean;
  promptContext?: string;
  taskId?: string;
  dispatchId?: string;
  reason?: string;
}

export class BridgeCollaborationAdapter {
  constructor(
    private readonly client: CollaborationClient,
    private readonly agentId: string,
    private readonly tenantKey: string,
    private readonly eventSource: 'distributed' | 'coordinator' = 'distributed',
  ) {}

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
      targetAgentIds: msg.mentionedBot ? [this.agentId] : [],
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

  private async waitForDispatch(taskId: string): Promise<Dispatch | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const pending = await this.client.dispatches(this.agentId);
      const dispatch = latestPendingForTask(pending.dispatches, taskId);
      if (dispatch) return dispatch;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  }

  private async acceptDispatch(
    msg: NormalizedMessage,
    taskId: string,
    dispatch: Dispatch,
  ): Promise<BridgeCollaborationDecision> {
    const context = await this.client.context(taskId, this.agentId);
    await this.client.acknowledge(dispatch.id, {
      agentId: this.agentId,
      status: 'accepted',
      idempotencyKey: `accept:${dispatch.id}:${msg.messageId}`,
    });
    return {
      managed: true,
      respond: true,
      promptContext: buildCollaborationContext({
      task: context.task,
        dispatch,
        entries: context.entries,
      }),
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
