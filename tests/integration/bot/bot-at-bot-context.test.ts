import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';
import { CollaborationHub } from '../../../src/collab/hub.js';
import { JsonlLedger } from '../../../src/collab/ledger.js';
import { CollaborationHubServer } from '../../../src/collab/server.js';

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
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
});

describe('bot identity injection into the agent adapter', () => {
  it('fences a racing old result when native input receipt fails and never retries the task', async () => {
    const h = await createHarness();
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const steer = vi.fn(async () => { throw Error('receipt uncertain'); });
    const stop = vi.fn(async () => { finish(); });
    const run = vi.spyOn(h.agent, 'run').mockImplementation(opts => ({
      runId: opts.runId, steer, stop, async waitForExit() { return true; },
      events: (async function* () { yield { type: 'activity' as const }; await finished; yield { type: 'text' as const, delta: 'STALE_RESULT' }; yield { type: 'done' as const }; })(),
    }));
    const rendered: string[] = [];
    vi.spyOn(h.channel, 'stream').mockImplementation(async (_chat, input) => {
      if (isMarkdownStreamInput(input)) await input.markdown({ async setContent(text) { rendered.push(text); } });
    });
    const send = vi.spyOn(h.channel, 'send');
    await startTestBridge(h);
    await h.channel.handlers.message?.(message({ messageId: 'first', content: 'Original', rawSenderType: 'user' }));
    await waitFor(() => run.mock.calls.length === 1);
    await h.channel.handlers.message?.(message({ messageId: 'failed-update', content: 'Correction', rawSenderType: 'user' }));
    await waitFor(() => rendered.some(text => text.includes('old result fenced')));
    expect(rendered.at(-1)).not.toContain('STALE_RESULT');
    expect(stop).toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).toContain('未自动重发');
  });
  it('delivers a second human mention into the active run instead of starting another run', async () => {
    const h = await createHarness();
    const hub = new CollaborationHub(new JsonlLedger(join(h.tmp.profile, 'live-hub.jsonl')), { agents: [{ id: 'world', displayName: 'Agent' }] });
    await hub.initialize(); hub.registerAgentIdentity('world', 'ou_bot', {});
    const server = new CollaborationHubServer(hub, { host: '127.0.0.1', port: 0, token: 'test' });
    const address = await server.listen(); cleanups.push(() => server.close());
    vi.stubEnv('LARK_COLLAB_HUB_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('LARK_COLLAB_HUB_TOKEN', 'test'); vi.stubEnv('LARK_COLLAB_AGENT_ID', 'world'); vi.stubEnv('LARK_COLLAB_TENANT_KEY', 'test');
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const steer = vi.fn(async () => {});
    const exited = vi.fn();
    const run = vi.spyOn(h.agent, 'run').mockImplementation(opts => ({
      runId: opts.runId, steer,
      events: (async function* () { yield { type: 'activity' as const }; await finished; yield { type: 'text' as const, delta: 'NEW_RESULT' }; yield { type: 'done' as const, terminationReason: 'normal' as const }; })(),
      async stop() { finish(); }, async waitForExit() { exited(); return true; },
    }));
    const send = vi.spyOn(h.channel, 'send');
    await startTestBridge(h);
    await h.channel.handlers.message?.(message({ messageId: 'first', content: 'Original task', rawSenderType: 'user' }));
    await waitFor(() => run.mock.calls.length === 1);
    await h.channel.handlers.message?.(message({ messageId: 'correction', content: 'Actually use the new direction', rawSenderType: 'user' }));
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]).toBeDefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).toContain('已将这条补充');
    await h.channel.handlers.message?.(message({ messageId: 'correction', content: 'Actually use the new direction', rawSenderType: 'user' }));
    expect(steer).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => exited.mock.calls.length > 0);
    await waitFor(() => hub.listDispatches('world').some(dispatch => dispatch.status === 'completed'));
    expect(hub.listDispatches('world').map(dispatch => dispatch.status)).toEqual(['failed', 'completed']);
  });
  it('sends two real mentions for two consultation markers in one final answer', async () => {
    const h = await createHarness();
    const hub = new CollaborationHub(new JsonlLedger(join(h.tmp.profile, 'hub.jsonl')), {
      agents: ['world', 'chariot', 'justice'].map(id => ({ id, displayName: id })),
    });
    await hub.initialize();
    hub.registerAgentIdentity('chariot', 'ou_chariot', {});
    hub.registerAgentIdentity('justice', 'ou_justice', {});
    const server = new CollaborationHubServer(hub, { host: '127.0.0.1', port: 0, token: 'test' });
    const address = await server.listen();
    cleanups.push(() => server.close());
    vi.stubEnv('LARK_COLLAB_HUB_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('LARK_COLLAB_HUB_TOKEN', 'test');
    vi.stubEnv('LARK_COLLAB_AGENT_ID', 'world');
    vi.stubEnv('LARK_COLLAB_TENANT_KEY', 'test');
    h.agent = new FakeAgentAdapter({ events: [
      { type: 'text', delta: 'Plan\n<collaboration_ask target="chariot">Write</collaboration_ask>\n<collaboration_ask target="justice">Draw</collaboration_ask>' },
      { type: 'done', terminationReason: 'normal' },
    ] });
    const send = vi.spyOn(h.channel, 'send');
    await startTestBridge(h);
    await h.channel.handlers.message?.(message({ messageId: 'om_parallel', content: 'Plan', rawSenderType: 'user' }));
    await waitFor(() => hub.listDispatches('justice').length === 1 && send.mock.calls.some(call => JSON.stringify(call[2]).includes('ou_justice')));
    expect(hub.listDispatches('chariot')).toHaveLength(1);
    expect(send.mock.calls.filter(call => JSON.stringify(call[2]).includes('ou_chariot'))).toHaveLength(1);
    expect(send.mock.calls.filter(call => JSON.stringify(call[2]).includes('ou_justice'))).toHaveLength(1);
    expect(hub.getTask(hub.listDispatches('justice')[0]!.taskId)?.ownerAgentId).toBe('world');
  });
  it('passes channel.botIdentity to the adapter after connect', async () => {
    const h = await createHarness();

    await startTestBridge(h);

    expect(h.agent.botIdentity).toEqual({ openId: 'ou_bot', name: 'Bridge' });
  });
});

describe('sender identity in bridge_context', () => {
  it('marks a bot sender via raw sender_type and injects botOpenId and mentions', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_from_bot',
        senderId: 'ou_hermes',
        senderName: 'HermesBot',
        content: '@Bridge 部署完成，请验证',
        rawSenderType: 'app',
        mentions: [
          { key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true },
          { key: '@_user_2', openId: 'ou_human', name: '张三', isBot: false },
        ],
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const context = readSection(h.agent.runOptions[0]?.prompt ?? '', 'bridge_context') as {
      senderType?: string;
      botOpenId?: string;
      mentions?: Array<{ openId?: string; name?: string; isBot?: boolean }>;
    };
    expect(context.senderType).toBe('bot');
    expect(context.botOpenId).toBe('ou_bot');
    expect(context.mentions).toEqual([
      { openId: 'ou_bot', name: 'Bridge', isBot: true },
      { openId: 'ou_human', name: '张三', isBot: false },
    ]);
  });

  it('marks a human sender via raw sender_type', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_from_user',
        content: '@Bridge 帮我看个问题',
        rawSenderType: 'user',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const context = readSection(h.agent.runOptions[0]?.prompt ?? '', 'bridge_context') as {
      senderType?: string;
    };
    expect(context.senderType).toBe('user');
  });

  it('omits senderType when the raw event is unavailable', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_no_raw',
        content: '@Bridge 在吗',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const context = readSection(h.agent.runOptions[0]?.prompt ?? '', 'bridge_context') as Record<
      string,
      unknown
    >;
    expect(context).not.toHaveProperty('senderType');
    expect(context.botOpenId).toBe('ou_bot');
  });

  it('turns a mention-only message into an explicit wake-up ping', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_empty_at',
        content: '',
        rawSenderType: 'user',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const userInput = readSection(h.agent.runOptions[0]?.prompt ?? '', 'user_input') as {
      text: string;
    };
    expect(userInput.text).toContain('唤醒');
    expect(userInput.text).toContain('没有正文');
  });

  it('annotates each message with its sender when a batch merges multiple senders', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_batch_user',
        senderId: 'ou_human',
        senderName: '张三',
        content: '@Bridge 这个报错怎么回事',
        rawSenderType: 'user',
      }),
    );
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_batch_bot',
        senderId: 'ou_hermes',
        senderName: 'HermesBot',
        content: '我刚发布了 v1.2.3',
        rawSenderType: 'app',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const userInput = readSection(h.agent.runOptions[0]?.prompt ?? '', 'user_input') as {
      text: string;
    };
    expect(userInput.text).toContain('[张三 (user)]:');
    expect(userInput.text).toContain('[HermesBot (bot)]:');
    expect(userInput.text).toContain('这个报错怎么回事');
    expect(userInput.text).toContain('我刚发布了 v1.2.3');
  });

  it('keeps single-message batches free of sender annotations', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_single',
        content: '@Bridge 看下这个',
        rawSenderType: 'user',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const userInput = readSection(h.agent.runOptions[0]?.prompt ?? '', 'user_input') as {
      text: string;
    };
    expect(userInput.text).not.toContain('[User (user)]:');
    expect(userInput.text).toContain('看下这个');
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('bot-at-bot-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_chat'],
      allowedUsers: ['ou_user'],
    },
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
  const channel = createFakeLarkChannel();
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

function createFakeLarkChannel(): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  return {
    handlers,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send() {},
    async stream(_chatId, input) {
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
  content: string;
  senderId?: string;
  senderName?: string;
  rawSenderType?: string;
  mentions?: Array<{ key: string; openId?: string; name?: string; isBot?: boolean }>;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: input.senderId ?? 'ou_user',
    senderName: input.senderName ?? 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: input.mentions ?? [
      { key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true },
    ],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1760000001000,
    ...(input.rawSenderType
      ? {
          raw: {
            sender: {
              sender_id: { open_id: input.senderId ?? 'ou_user' },
              sender_type: input.rawSenderType,
            },
            message: { message_id: input.messageId },
          },
        }
      : {}),
  } as unknown as NormalizedMessage;
}

function readSection(prompt: string, tag: string): unknown {
  const match = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  if (!match) throw new Error(`missing section ${tag}`);
  return JSON.parse(match[1] ?? 'null') as unknown;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}
