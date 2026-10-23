import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { AgentPreflightError, type AgentAvailability } from '../preflight';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export class AntigravityDesktopAdapter implements AgentAdapter {
  readonly id = 'antigravity';
  readonly displayName = 'Antigravity App';
  private identity?: AgentBotIdentity;
  constructor(private readonly root: string, private readonly larkChannel?: LarkChannelEnvContext) {}
  setBotIdentity(identity: AgentBotIdentity): void { this.identity = identity; }
  async isAvailable(): Promise<boolean> {
    try { const heartbeat = JSON.parse(readFileSync(join(this.root, 'heartbeat.json'), 'utf8')) as { at: number; transport: string }; return heartbeat.transport === 'antigravity-app' && Math.abs(Date.now() - heartbeat.at) < 10000; } catch { return false; }
  }
  async checkAvailability(): Promise<AgentAvailability> {
    if (await this.isAvailable()) return { ok: true };
    const diagnostic = { code: 'agent-binary-not-readable' as const, agentId: 'antigravity' as const, agentName: this.displayName, command: 'Antigravity App Sidecar', field: 'antigravity.desktopRoot' };
    return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic, 'Antigravity App Sidecar is offline. CLI fallback is disabled.') };
  }
  async prepareRun(): Promise<void> { if (!await this.isAvailable()) throw Error('Antigravity App Sidecar is offline; open the App and enable this Worker Sidecar. CLI fallback is disabled.'); }
  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd || !/^[a-zA-Z0-9_-]{1,100}$/.test(opts.runId)) throw Error('Invalid desktop run binding');
    if (opts.model) throw Error('Desktop transport uses the model selected in the App; per-run CLI model overrides are unsupported.');
    const dir = join(this.root, 'runs', opts.runId);
    mkdirSync(dir, { recursive: true });
    if (existsSync(join(dir, 'request.json'))) throw Error('Desktop run ID already exists');
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (/^LARK_(?:COLLAB_|CHANNEL_|MEMORY_)|^LARKSUITE_CLI_|^PATH$/i.test(key)) env[key] = value;
    Object.assign(env, buildLarkChannelEnv(this.larkChannel), opts.env);
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const publish = (name: string, value: unknown) => { const file = join(dir, name); writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 }); renameSync(file + '.tmp', file); };
    publish('lease.json', { at: Date.now() });
    const heartbeat = JSON.parse(readFileSync(join(this.root, 'heartbeat.json'), 'utf8')) as { workspaceRoot?: string };
    publish('request.json', { runId: opts.runId, nonce: randomBytes(16).toString('hex'), cwd: resolve(opts.cwd), workspaceRoot: heartbeat.workspaceRoot ?? resolve(opts.cwd), prompt: opts.memoryMode ? opts.prompt : prefixBridgeSystemPrompt(opts.prompt, this.identity), env, memoryMode: opts.memoryMode === true, expires: Date.now() + 86400000 });
    let ended = false, stopped = false;
    const adapter = this;
    const lease = setInterval(() => { if (!ended) publish('lease.json', { at: Date.now() }); }, 2000); lease.unref();
    const stop = async () => { if (ended) return; stopped = true; publish('cancel.json', { reason: 'bridge cancelled', at: Date.now() }); clearInterval(lease); ended = true; };
    async function* events(): AsyncGenerator<AgentEvent> {
      let delivered = 0, conversation = false;
      try {
        while (!stopped) {
          if (!await adapter.isAvailable()) { publish('cancel.json', { reason: 'desktop disconnected' }); yield { type: 'error', message: 'Antigravity App Sidecar disconnected', terminationReason: 'failed' }; return; }
          if (!conversation && existsSync(join(dir, 'conversation.json'))) { const data = JSON.parse(readFileSync(join(dir, 'conversation.json'), 'utf8')); conversation = true; yield { type: 'system', sessionId: data.conversationId }; }
          const file = join(dir, 'events.jsonl');
          if (existsSync(file)) {
            const lines = readFileSync(file, 'utf8').split('\n');
            for (; delivered < lines.length - 1; delivered++) { const event = JSON.parse(lines[delivered]!); if (event.type === 'activity') yield { type: 'activity', summary: event.summary }; }
          }
          if (existsSync(join(dir, 'result.json'))) {
            const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
            if (result.type === 'done') { yield { type: 'text', delta: result.text }; yield { type: 'done', sessionId: result.conversationId, terminationReason: 'normal' }; }
            else yield { type: 'error', message: result.message, terminationReason: result.reason === 'interrupted' ? 'interrupted' : 'failed' };
            return;
          }
          await pause(250);
        }
        yield { type: 'done', terminationReason: 'interrupted' };
      } finally {
        if (!existsSync(join(dir, 'result.json')) && !existsSync(join(dir, 'cancel.json'))) publish('cancel.json', { reason: 'bridge event consumer exited' });
        ended = true; clearInterval(lease);
      }
    }
    return { runId: opts.runId, events: events(), stop, async waitForExit(ms) { const end = Date.now() + ms; while (!ended && Date.now() < end) await pause(25); return ended; } };
  }
}
