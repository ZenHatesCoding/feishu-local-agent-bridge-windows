import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';
import { MemoryStore } from '../../../src/memory/store';
import { CollaborationHub } from '../../../src/collab/hub';
import { JsonlLedger } from '../../../src/collab/ledger';
import { CollaborationHubServer } from '../../../src/collab/server';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  sent: Array<{ chatId: string; content: unknown; options: unknown }>;
  streams: Array<{ chatId: string; options: unknown }>;
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    im: {
      v1: {
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  getAppInfo: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  fetchRawMessage: ReturnType<typeof vi.fn>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

describe('topic message quote handling', () => {
  it('records quiet ordinary-group messages in the Hub before a later mention, without waking on observations', async () => {
    const h = await createHarness({ chatMode: 'group' });
    const hub = new CollaborationHub(new JsonlLedger(join(h.tmp.root, 'hub-ledger.jsonl')), { agents: [{ id: 'worker', displayName: 'Bridge' }] });
    await hub.initialize();
    const server = new CollaborationHubServer(hub, { host: '127.0.0.1', port: 0, token: 'test' });
    const address = await server.listen(); cleanups.push(() => server.close());
    vi.stubEnv('LARK_COLLAB_HUB_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('LARK_COLLAB_HUB_TOKEN', 'test');
    vi.stubEnv('LARK_COLLAB_AGENT_ID', 'worker'); vi.stubEnv('LARK_COLLAB_TENANT_KEY', 'tenant');
    vi.stubEnv('LARK_COLLAB_EVENT_SOURCE', 'distributed'); vi.stubEnv('LARK_MEMORY_ENABLED', '1');
    vi.stubEnv('LARK_MEMORY_ROOT', join(h.tmp.root, 'memory')); vi.stubEnv('LARK_MEMORY_BACKGROUND', '0');
    vi.stubEnv('LARK_COLLAB_NODE_LEDGER_ROOT', join(h.tmp.root, 'journal'));
    await startTestBridge(h);
    const quiet = { ...message({ messageId: 'quiet', rootId: 'quiet', parentId: 'quiet', content: '报告必须有三页和对比表' }), mentionedBot: false, mentions: [] };
    await h.channel.handlers.message?.(quiet);
    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(0); expect(h.channel.streams).toHaveLength(0);
    await h.channel.handlers.message?.(message({ messageId: 'later', rootId: 'later', parentId: 'later', content: '@Bridge 根据前面的要求开始' }));
    await waitFor(() => h.agent.runOptions.length === 1, 2500);
    expect(h.agent.runOptions[0]!.prompt).toContain('报告必须有三页和对比表');
    expect(h.agent.runOptions[0]!.prompt).toContain('<collaboration_context>');
    expect(h.agent.runOptions[0]!.prompt).toContain('"scope":"oc_topic_chat"');
  });
  it('automatically injects the Worker topic ledger into a fresh second run without duplicating the new message', async () => {
    const h = await createHarness();
    const memoryRoot = join(h.tmp.root, 'memory');
    vi.stubEnv('LARK_MEMORY_ENABLED', '1');
    vi.stubEnv('LARK_MEMORY_ROOT', memoryRoot);
    vi.stubEnv('LARK_MEMORY_BACKGROUND', '0');
    for (const name of ['LARK_COLLAB_AGENT_ID','LARK_COLLAB_TENANT_KEY','LARK_COLLAB_HUB_URL','LARK_COLLAB_HUB_TOKEN']) vi.stubEnv(name, undefined);
    vi.stubEnv('LARK_COLLAB_NODE_LEDGER_ROOT', join(h.tmp.root, 'journal'));
    h.agent.setEvents([
      [{ type: 'text', delta: '第一轮已经完成分析。' }, { type: 'done', terminationReason: 'normal' }],
      [{ type: 'text', delta: '接着处理。' }, { type: 'done', terminationReason: 'normal' }],
    ]);
    await startTestBridge(h);
    await h.channel.handlers.message?.(message({ messageId: 'om_mem_1', rootId: 'root', parentId: 'root', threadId: 'memory-topic', content: '先分析设计' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    await waitFor(() => h.channel.streams.length === 1);
    await new Promise(resolve => setTimeout(resolve, 80));
    await h.channel.handlers.message?.(message({ messageId: 'om_mem_2', rootId: 'root', parentId: 'root', threadId: 'memory-topic', content: '独特的本轮新要求' }));
    await waitFor(() => h.agent.runOptions.length === 2);
    const second = h.agent.runOptions[1]!;
    expect(second.prompt).toContain('<worker_topic_memory>');
    expect(second.prompt).toContain('第一轮已经完成分析');
    expect(second.prompt.match(/独特的本轮新要求/g)).toHaveLength(1);
    expect(second.env?.LARK_MEMORY_BINDING).toContain(memoryRoot);
    expect(second.sessionId).toBeUndefined();
    const db = new MemoryStore(memoryRoot, 'test', 'cli_test');
    try { expect(db.events(db.topic('oc_topic_chat:memory-topic').id).length).toBeGreaterThanOrEqual(3); }
    finally { db.close(); }
  });
  it('does not quote the topic root when a user directly mentions the bot inside the topic', async () => {
    const h = await createHarness();

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_direct_at',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_topic',
        content: '@Bridge 继续说一下',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions).toHaveLength(1);
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('"threadId":"omt_topic"');
    expect(prompt).not.toContain('<quoted_messages>');
    expect(prompt).not.toContain('topic root content');
    expect(h.channel.fetchRawMessage).not.toHaveBeenCalled();
  });

  it('treats messages with threadId as topic messages even when chat mode cache says group', async () => {
    const h = await createHarness({ chatMode: 'group' });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_converted_topic',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_converted_topic',
        content: '@Bridge 继续说一下',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('"threadId":"omt_converted_topic"');
    expect(prompt).not.toContain('<quoted_messages>');
    expect(h.channel.fetchRawMessage).not.toHaveBeenCalled();
    await waitFor(() => h.channel.streams.length === 1);
    expect(h.channel.streams[0]?.options).toMatchObject({
      replyTo: 'om_converted_topic',
      replyInThread: true,
    });
  });

  it('keeps regular group reply quotes as quoted context', async () => {
    const h = await createHarness({
      chatMode: 'group',
      quotedMessages: {
        om_quote_target: 'regular quoted content',
      },
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_group_reply',
        rootId: 'om_quote_target',
        parentId: 'om_quote_target',
        content: '@Bridge 看这条',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<quoted_messages>');
    expect(prompt).toContain('regular quoted content');
    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith(
      'om_quote_target',
      expect.objectContaining({ cardContentType: 'user_card_content' }),
    );
  });

  it('keeps non-root reply quotes in topic chats', async () => {
    const h = await createHarness({
      quotedMessages: {
        om_topic_parent: 'topic parent content',
      },
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_topic_reply',
        rootId: 'om_topic_root',
        parentId: 'om_topic_parent',
        threadId: 'omt_topic',
        content: '@Bridge 看父消息',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<quoted_messages>');
    expect(prompt).toContain('topic parent content');
    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith(
      'om_topic_parent',
      expect.objectContaining({ cardContentType: 'user_card_content' }),
    );
  });

  it.each(['claude', 'codex', 'antigravity', 'deepseek-harness'] as const)(
    'does not send a synthetic intake acknowledgement for %s',
    async (agentKind) => {
      const h = await createHarness({ agentKind });
      await startTestBridge(h);

      await h.channel.handlers.message?.(
        message({
          messageId: 'om_harness',
          rootId: 'om_topic_root',
          parentId: 'om_topic_root',
          threadId: 'omt_topic',
          content: '@Bridge 做一个长任务',
        }),
      );

      await waitFor(() => h.agent.runOptions.length === 1);
      expect(h.channel.sent).not.toContainEqual(
        expect.objectContaining({
          content: { markdown: '已收到，正在处理。完成后会在本话题发送最终结果。' },
        }),
      );
    },
  );

  it.each(['antigravity', 'deepseek-harness'] as const)(
    'keeps final-output %s non-streaming without a synthetic reply',
    async (agentKind) => {
      const h = await createHarness({ agentKind });
      await startTestBridge(h);

      await h.channel.handlers.message?.(
        message({
          messageId: 'om_harness',
          rootId: 'om_topic_root',
          parentId: 'om_topic_root',
          threadId: 'omt_topic',
          content: '@Bridge 做一个长任务',
        }),
      );

      await waitFor(() => h.agent.runOptions.length === 1);
      expect(h.channel.streams).toHaveLength(0);
    },
  );
});

async function createHarness(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  agentKind?: 'claude' | 'codex' | 'antigravity' | 'deepseek-harness';
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('topic-quote-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: options.agentKind ?? 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_topic_chat'],
      allowedUsers: ['ou_user'],
    },
    ...(options.agentKind === 'codex'
      ? { codex: { binaryPath: 'codex' } }
      : options.agentKind === 'deepseek-harness'
      ? { deepseekHarness: { binaryPath: 'node', entryPath: '/harness/cli.js' } }
      : options.agentKind === 'antigravity'
        ? { antigravity: { binaryPath: 'agy', printTimeout: '60m' } }
        : {}),
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
} = {}): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  const sent: Array<{ chatId: string; content: unknown; options: unknown }> = [];
  const streams: Array<{ chatId: string; options: unknown }> = [];
  const chatMode = options.chatMode ?? 'topic';
  const quotedMessages = options.quotedMessages ?? {
    om_topic_root: 'topic root content',
  };
  return {
    handlers,
    sent,
    streams,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_owner' })),
    listChats: vi.fn(async () => []),
    fetchRawMessage: vi.fn(async (messageId: string) => [
      {
        message_id: messageId,
        msg_type: 'text',
        body: {
          content: JSON.stringify({
            text: quotedMessages[messageId] ?? 'quoted content',
          }),
        },
        create_time: '1760000000000',
        sender: { id: 'ou_quote_sender' },
      },
    ]),
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return chatMode;
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      return { messageId: `om_sent_${sent.length}` };
    },
    async stream(chatId, input, options) {
      streams.push({ chatId, options });
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
    },
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(input: {
  messageId: string;
  rootId: string;
  parentId: string;
  threadId?: string;
  content: string;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_topic_chat',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
    mentionAll: false,
    mentionedBot: true,
    rootId: input.rootId,
    parentId: input.parentId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    replyToMessageId: input.parentId,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
