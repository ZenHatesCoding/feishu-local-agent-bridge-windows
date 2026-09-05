import {
  createLarkChannel,
  type LarkChannel,
  type LarkChannelOptions,
  type NormalizedMessage,
} from '@larksuite/channel';
import type { CollaborationHub } from './hub';
import type { AgentRegistration, MessageInput } from './types';

export interface FeishuCoordinatorOptions {
  tenant: 'feishu' | 'lark';
  appId: string;
  appSecret: string;
  tenantKey: string;
  agents: AgentRegistration[];
}

export interface FeishuCoordinator {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export async function startFeishuCoordinator(
  hub: CollaborationHub,
  options: FeishuCoordinatorOptions,
): Promise<FeishuCoordinator> {
  const channelOptions: LarkChannelOptions = {
    appId: options.appId,
    appSecret: options.appSecret,
    domain: options.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
    source: 'lark-collaboration-coordinator',
    policy: { dmMode: 'open', requireMention: false, respondToMentionAll: false },
    safety: { chatQueue: { enabled: false } },
    includeRawEvent: true,
    respectProxyEnv: process.env.LARK_CHANNEL_DISABLE_PROXY !== '1',
  };
  const channel = createLarkChannel(channelOptions);
  channel.on({
    message: async (msg) => {
      const input = coordinatorInputForMessage(msg, options);
      if (!input) return;
      await hub.submit(input).catch((err) => {
        console.error(`[collab-coordinator] failed to record ${msg.messageId}: ${String(err)}`);
      });
    },
    error: (err) => console.error(`[collab-coordinator] channel error: ${err?.message ?? String(err)}`),
  });
  await channel.connect();
  console.log(`Feishu coordinator connected as ${channel.botIdentity?.name ?? options.appId}`);
  return { channel, disconnect: () => channel.disconnect() };
}

export function coordinatorInputForMessage(
  msg: NormalizedMessage,
  options: Pick<FeishuCoordinatorOptions, 'tenantKey' | 'agents'>,
): MessageInput | undefined {
  if (msg.chatType === 'p2p' || !msg.threadId) return undefined;
  const senderType = rawSenderType(msg);
  const actorId = senderType === 'agent'
    ? resolveAgentIdentity(msg.senderId, msg.senderName, options.agents) ?? msg.senderId
    : msg.senderId;
  return {
    type: 'message',
    idempotencyKey: `feishu-message:${msg.messageId}`,
    address: { tenantKey: options.tenantKey, chatId: msg.chatId, threadId: msg.threadId },
    messageId: msg.messageId,
    actor: {
      type: senderType,
      id: actorId,
      ...(msg.senderName ? { name: msg.senderName } : {}),
    },
    content: msg.content || '(empty message)',
    targetAgentIds: resolveMentionedAgents(msg, options.agents),
  };
}

export function resolveMentionedAgents(
  msg: Pick<NormalizedMessage, 'mentions'>,
  agents: AgentRegistration[],
): string[] {
  const targets = new Set<string>();
  for (const mention of msg.mentions ?? []) {
    const candidates = [mention.openId, mention.name].filter((value): value is string => Boolean(value));
    for (const agent of agents) {
      const identities = [agent.id, agent.displayName, ...(agent.aliases ?? [])];
      if (candidates.some((candidate) => identities.some((identity) => equalIdentity(candidate, identity)))) {
        targets.add(agent.id);
      }
    }
  }
  return [...targets];
}

function rawSenderType(msg: NormalizedMessage): 'human' | 'agent' {
  const raw = msg.raw as { sender?: { sender_type?: unknown } } | undefined;
  const senderType = raw?.sender?.sender_type;
  return senderType === 'app' || senderType === 'bot' ? 'agent' : 'human';
}

function resolveAgentIdentity(
  senderId: string,
  senderName: string | undefined,
  agents: AgentRegistration[],
): string | undefined {
  return agents.find((agent) => {
    const identities = [agent.id, agent.displayName, ...(agent.aliases ?? [])];
    return identities.some((identity) => equalIdentity(identity, senderId) || equalIdentity(identity, senderName));
  })?.id;
}

function equalIdentity(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase());
}
