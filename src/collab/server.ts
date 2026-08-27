import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { CollaborationHub } from './hub';
import type { HubInput } from './types';

export interface HubServerOptions {
  host?: string;
  port?: number;
  token: string;
  agentTokens?: Record<string, string>;
  maxBodyBytes?: number;
}

export class CollaborationHubServer {
  private server?: Server;

  constructor(private readonly hub: CollaborationHub, private readonly options: HubServerOptions) {}

  async listen(): Promise<{ host: string; port: number }> {
    if (!this.options.token) throw new Error('hub token is required');
    if (this.server) throw new Error('hub server is already listening');
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 17321, this.options.host ?? '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    return { host: address.address, port: address.port };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true });
      }
      const principal = this.authenticate(req);
      if (!principal) {
        return json(res, 401, { error: 'unauthorized' });
      }
      if (req.method === 'POST' && url.pathname === '/v1/events') {
        const body = await readJson(req, this.options.maxBodyBytes ?? 256 * 1024) as HubInput;
        authorizeEvent(principal, body);
        return json(res, 200, await this.hub.submit(body));
      }
      if (req.method === 'GET' && url.pathname === '/v1/agents') {
        return json(res, 200, { agents: this.hub.listAgentIdentities() });
      }
      const identityMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/identity$/);
      if (req.method === 'POST' && identityMatch) {
        const agentId = decodeURIComponent(identityMatch[1]!);
        authorizeAgent(principal, agentId);
        const body = await readJson(req, this.options.maxBodyBytes ?? 256 * 1024) as {
          openId?: string;
          nodeId?: string;
          instanceId?: string;
          version?: string;
        };
        if (!body.openId) throw new Error('openId is required');
        return json(res, 200, {
          agent: this.hub.registerAgentIdentity(agentId, body.openId, {
            ...(body.nodeId ? { nodeId: body.nodeId } : {}),
            ...(body.instanceId ? { instanceId: body.instanceId } : {}),
            ...(body.version ? { version: body.version } : {}),
          }),
        });
      }
      const contextMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/context$/);
      if (req.method === 'GET' && contextMatch) {
        const agentId = requiredQuery(url, 'agentId');
        authorizeAgent(principal, agentId);
        const after = numberQuery(url, 'after');
        const taskId = decodeURIComponent(contextMatch[1]!);
        const task = this.hub.getTask(taskId);
        if (!task) return json(res, 404, { error: 'task not found' });
        return json(res, 200, {
          task,
          entries: this.hub.getContext(taskId, agentId, after),
          artifacts: this.hub.getArtifacts(taskId, agentId),
        });
      }
      const dispatchListMatch = url.pathname.match(/^\/v1\/dispatches\/agents\/([^/]+)$/);
      if (req.method === 'GET' && dispatchListMatch) {
        const agentId = decodeURIComponent(dispatchListMatch[1]!);
        authorizeAgent(principal, agentId);
        return json(res, 200, { dispatches: this.hub.listDispatches(agentId, numberQuery(url, 'after')) });
      }
      const ackMatch = url.pathname.match(/^\/v1\/dispatches\/([^/]+)\/ack$/);
      if (req.method === 'POST' && ackMatch) {
        const body = await readJson(req, this.options.maxBodyBytes ?? 256 * 1024) as {
          agentId?: string;
          status?: 'accepted' | 'completed' | 'failed';
          idempotencyKey?: string;
        };
        if (!body.agentId || !body.status || !body.idempotencyKey) throw new Error('invalid ack body');
        authorizeAgent(principal, body.agentId);
        const dispatch = await this.hub.acknowledge(
          decodeURIComponent(ackMatch[1]!), body.agentId, body.status, body.idempotencyKey,
        );
        return json(res, 200, { dispatch });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof AuthorizationError) return json(res, 403, { error: err.message });
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private authenticate(req: IncomingMessage): Principal | undefined {
    const raw = req.headers.authorization;
    if (!raw?.startsWith('Bearer ')) return undefined;
    const token = raw.slice('Bearer '.length);
    if (sameSecret(token, this.options.token)) return { kind: 'admin' };
    for (const [agentId, agentToken] of Object.entries(this.options.agentTokens ?? {})) {
      if (sameSecret(token, agentToken)) return { kind: 'agent', agentId };
    }
    return undefined;
  }
}

type Principal = { kind: 'admin' } | { kind: 'agent'; agentId: string };

function authorizeAgent(principal: Principal, agentId: string): void {
  if (principal.kind === 'agent' && principal.agentId !== agentId) {
    throw new AuthorizationError('agent credential cannot act as another agent');
  }
}

function authorizeEvent(principal: Principal, input: HubInput): void {
  if (principal.kind === 'admin') return;
  if (input.type === 'message') {
    if (input.targetAgentIds.some((id) => id !== principal.agentId)) {
      throw new AuthorizationError('agent credential can only route an observed message to itself');
    }
    return;
  }
  authorizeAgent(principal, input.actorAgentId);
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

class AuthorizationError extends Error {}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) throw new Error('request body is required');
  return JSON.parse(text) as unknown;
}

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function numberQuery(url: URL, key: string): number {
  const raw = url.searchParams.get(key);
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${key} must be a non-negative integer`);
  return parsed;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}
