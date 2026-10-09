import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { CollaborationHub } from '../collab/hub';
import { buildLanCollaborationContext } from './context';
import { hashPassword, newToken, safeEqual, tokenHash, verifyPassword } from './auth';
import { LanFileStore } from './files';
import { LanEventBus, type LanConversationNotification } from './events';
import { SqliteLanStore } from './sqlite';
import { taskIdFor } from '../collab/task-id';
import type { HubInput, LedgerRecord, SharedArtifact } from '../collab/types';
import {
  LAN_RUN_EVENT_TYPES,
  type LanCatchUpResult,
  type LanCenterConfig,
  type LanClaimResult,
  type LanConversation,
  type LanHeartbeatResult,
  type LanRunEvent,
  type LanStore,
  type LanTaskState,
} from './types';

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90_000;
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

type Principal =
  | { kind: 'user'; username: string }
  | { kind: 'agent'; agentId: string };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The LAN collaboration center: the deterministic Hub state machine over a
 * SQLite ledger, plus the pieces the Feishu channel used to provide — user
 * sessions, a browser API with SSE, authorized file delivery and worker
 * claim/lease/attempt bookkeeping.
 */
export class LanCenter {
  readonly hub: CollaborationHub;
  readonly store: LanStore;
  readonly files: LanFileStore;
  readonly bus = new LanEventBus();
  private server?: Server;
  private heartbeatTimer?: NodeJS.Timeout;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly heartbeatTimeoutMs: number;
  private readonly agentTokens = new Map<string, string>();
  /** Per-conversation ledger sequence already fanned out over SSE. */
  private readonly publishedLedgerSeq = new Map<string, number>();

  constructor(readonly config: LanCenterConfig) {
    const store = new SqliteLanStore(config.deploymentId, join(config.dataDir, 'center.db'));
    this.store = store;
    this.hub = new CollaborationHub(store, {
      agents: config.agents,
      leaseMs: (config.leaseMinutes ?? 30) * 60_000,
      maxCausalDepth: config.maxCausalDepth,
      maxConversationTurns: config.maxConversationTurns,
    });
    this.files = new LanFileStore(join(config.dataDir, 'files'));
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  }

  async initialize(): Promise<void> {
    await this.hub.initialize();
    this.bootstrapUsers();
    this.bootstrapAgentCredentials();
    // Attempts that were active when the process died have no running worker
    // anymore; mark them uncertain instead of silently re-running side effects.
    for (const attempt of this.store.listAttempts({ state: 'active' })) {
      this.store.setAttemptState(attempt.id, 'uncertain');
    }
    // Seed the live-push cursor so reconnecting clients only get new records.
    for (const conversation of this.store.listConversations()) {
      const records = this.store.ledgerRecordsForConversation(conversation.id, 0);
      if (records.length > 0) {
        this.publishedLedgerSeq.set(conversation.id, records[records.length - 1]!.sequence);
      }
    }
  }

  private bootstrapUsers(): void {
    for (const user of this.config.users) {
      const hash = user.passwordHash ?? (user.password ? hashPassword(user.password) : undefined);
      if (!hash) throw new Error(`user ${user.username} needs a password or passwordHash`);
      this.store.upsertUser({
        username: user.username,
        displayName: user.displayName ?? user.username,
        passwordHash: hash,
      });
    }
  }

  /**
   * First boot generates one long-lived token per agent, stores its hash and
   * writes the plaintext to `<dataDir>/credentials/<agentId>.token` (mode
   * 600). Rotation = delete the file (or the DB row) and restart the center.
   */
  private bootstrapAgentCredentials(): void {
    const credentialDir = join(this.config.dataDir, 'credentials');
    mkdirSync(credentialDir, { recursive: true });
    for (const agent of this.config.agents) {
      const tokenFile = join(credentialDir, `${agent.id}.token`);
      const existingHash = this.store.getAgentToken(agent.id);
      if (existingHash && existsSync(tokenFile)) {
        // Reload the plaintext so in-process workers (sim) keep working after
        // a center restart without regenerating (which would fence live nodes).
        const existing = readFileSync(tokenFile, 'utf8').trim();
        if (existing) {
          this.agentTokens.set(agent.id, existing);
          continue;
        }
      }
      const token = newToken();
      this.store.setAgentToken(agent.id, tokenHash(token));
      writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
      this.agentTokens.set(agent.id, token);
    }
  }

  listen(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error('LAN center is already listening');
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    return new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(this.config.listen.port, this.config.listen.host, () => {
        const address = server.address() as AddressInfo;
        this.heartbeatTimer = setInterval(
          () => this.scanHeartbeats(),
          Math.min(15_000, Math.max(1_000, this.heartbeatTimeoutMs / 2)),
        );
        this.heartbeatTimer.unref();
        resolveListen({ host: address.address, port: address.port });
      });
    });
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((err) => (err ? rejectClose(err) : resolveClose())));
    }
    this.store.close();
  }

  /** Plaintext agent token, available right after bootstrap (sim/testing). */
  agentToken(agentId: string): string | undefined {
    return this.agentTokens.get(agentId);
  }

  private scanHeartbeats(): void {
    const threshold = Date.now() - this.heartbeatTimeoutMs;
    for (const attempt of this.store.listAttempts({ state: 'active' })) {
      if (Date.parse(attempt.heartbeatAt) >= threshold) continue;
      this.store.setAttemptState(attempt.id, 'uncertain');
      const dispatch = this.hub.getDispatch(attempt.dispatchId);
      if (dispatch) this.publishTask(dispatch.taskId);
    }
  }

  // ---- write serialization (claims and completions race across workers) ----

  private serialized<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.writeQueue.then(() => operation());
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  // ---- task state derivation (A2A TaskState vocabulary) ----

  taskStateFor(taskId: string): { state: LanTaskState; ownerAgentId?: string } {
    if (this.store.isTaskCanceled(taskId)) return { state: 'canceled' };
    const task = this.hub.getTask(taskId);
    if (!task) return { state: 'submitted' };
    const base = { ownerAgentId: task.ownerAgentId };
    if (task.status === 'completed') return { state: 'completed', ...base };
    const dispatches = this.hub.listTaskDispatches(taskId);
    if (dispatches.length > 0) {
      const hasActiveAttempt = dispatches.some((dispatch) =>
        this.store.attemptsForDispatch(dispatch.id).some((attempt) => attempt.state === 'active'));
      if (hasActiveAttempt) return { state: 'working', ...base };
      const pending = dispatches.filter((dispatch) => dispatch.status === 'pending');
      if (pending.length > 0) {
        return pending.some((dispatch) => dispatch.reason === 'ask' || dispatch.reason === 'return')
          ? { state: 'input-required', ...base }
          : { state: 'submitted', ...base };
      }
      if (dispatches.every((dispatch) => dispatch.status === 'failed')) {
        return { state: 'failed', ...base };
      }
      // All dispatches are terminal with no active attempt: the loop is idle
      // and waits for the user's next message.
      return { state: 'input-required', ...base };
    }
    return { state: 'submitted', ...base };
  }

  conversationView(row: { id: string; title: string; createdAt: string; createdBy: string }): LanConversation {
    const taskId = taskIdFor({ deploymentId: this.config.deploymentId, conversationId: row.id });
    const { state, ownerAgentId } = this.taskStateFor(taskId);
    const records = this.store.ledgerRecordsForConversation(row.id, 0);
    const lastActivityAt = records.length > 0 ? records[records.length - 1]!.recordedAt : row.createdAt;
    return { ...row, state, ...(ownerAgentId ? { ownerAgentId } : {}), lastActivityAt };
  }

  private conversationIdForTask(taskId: string): string | undefined {
    for (const conversation of this.store.listConversations()) {
      if (taskIdFor({ deploymentId: this.config.deploymentId, conversationId: conversation.id }) === taskId) {
        return conversation.id;
      }
    }
    return undefined;
  }

  private publishTask(taskId: string): void {
    const conversationId = this.conversationIdForTask(taskId);
    if (!conversationId) return;
    const { state, ownerAgentId } = this.taskStateFor(taskId);
    this.bus.publish({
      conversationId,
      kind: 'task',
      task: {
        taskId,
        state,
        ...(ownerAgentId ? { ownerAgentId } : {}),
        dispatches: this.hub.listTaskDispatches(taskId),
      },
    });
  }

  /** Push ledger records committed since the previous fan-out for this task. */
  private publishLedger(taskId: string): void {
    const conversationId = this.conversationIdForTask(taskId);
    if (!conversationId) return;
    const after = this.publishedLedgerSeq.get(conversationId) ?? 0;
    const records = this.store.ledgerRecordsForConversation(conversationId, after);
    if (records.length === 0) return;
    this.publishedLedgerSeq.set(conversationId, records[records.length - 1]!.sequence);
    this.bus.publish({ conversationId, kind: 'ledger', ledger: records });
  }

  // ---- HTTP surface ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, deploymentId: this.config.deploymentId });
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return this.serveStatic(url.pathname, res);
      }
      const streamMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/stream$/);
      if (req.method === 'GET' && streamMatch) {
        return this.handleStream(req, res, decodeURIComponent(streamMatch[1]!), url);
      }
      if (req.method === 'POST' && url.pathname === '/api/session') {
        // Login is the only route reachable without a principal.
        return this.handleLogin(res, await readJson(req));
      }
      const principal = this.authenticate(req, url);
      if (req.method === 'POST' && url.pathname === '/api/files') {
        return this.acceptUpload(req, res, principal);
      }
      const body = await readJson(req);
      await this.route(req, res, url, principal, body);
    } catch (err) {
      if (res.writableEnded) return;
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private authenticate(req: IncomingMessage, url: URL): Principal {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : url.searchParams.get('token') ?? undefined;
    if (!bearer) throw new HttpError(401, 'unauthorized');
    const hash = tokenHash(bearer);
    const session = this.store.getSession(hash);
    if (session) {
      if (Date.parse(session.expiresAt) < Date.now()) {
        this.store.deleteSession(hash);
        throw new HttpError(401, 'session expired');
      }
      if (!this.store.getUser(session.username)) {
        this.store.deleteSession(hash);
        throw new HttpError(401, 'unknown user');
      }
      return { kind: 'user', username: session.username };
    }
    for (const agent of this.config.agents) {
      const stored = this.store.getAgentToken(agent.id);
      if (stored && safeEqual(hash, stored)) return { kind: 'agent', agentId: agent.id };
    }
    throw new HttpError(401, 'unauthorized');
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    principal: Principal,
    body: unknown,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    // ---- session ----
    if (method === 'POST' && path === '/api/session/logout') {
      this.requireUser(principal);
      const header = req.headers.authorization;
      const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
      if (bearer) this.store.deleteSession(tokenHash(bearer));
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/api/me') {
      this.requireUser(principal);
      const user = this.store.getUser(principal.username);
      return json(res, 200, {
        user: { username: principal.username, displayName: user?.displayName ?? principal.username },
      });
    }

    // ---- agents ----
    if (method === 'GET' && path === '/api/agents') {
      this.requireUser(principal);
      const identities = new Map(this.hub.listAgentIdentities().map((identity) => [identity.id, identity]));
      return json(res, 200, {
        agents: this.config.agents.map((agent) => ({
          id: agent.id,
          displayName: agent.displayName,
          online: identities.has(agent.id),
          lastSeenAt: identities.get(agent.id)?.lastSeenAt,
        })),
      });
    }

    // ---- conversations ----
    if (method === 'GET' && path === '/api/conversations') {
      this.requireUser(principal);
      return json(res, 200, {
        conversations: this.store.listConversations().map((row) => this.conversationView(row)),
      });
    }
    if (method === 'POST' && path === '/api/conversations') {
      this.requireUser(principal);
      const input = body as { title?: string };
      const title = input?.title?.trim() || 'New conversation';
      const id = `conv_${randomUUID().slice(0, 12)}`;
      this.store.createConversation({
        id,
        title,
        createdBy: principal.username,
        createdAt: new Date().toISOString(),
      });
      return json(res, 200, { conversation: this.conversationView(this.store.getConversation(id)!) });
    }
    const conversationMatch = path.match(/^\/api\/conversations\/([^/]+)(?:\/(.*))?$/);
    if (conversationMatch) {
      const conversationId = decodeURIComponent(conversationMatch[1]!);
      const sub = conversationMatch[2] ?? '';
      if (!this.store.getConversation(conversationId)) throw new HttpError(404, 'conversation not found');
      if (method === 'GET' && sub === 'events') {
        this.requireUser(principal);
        return json(res, 200, this.catchUp(conversationId, url));
      }
      if (method === 'POST' && sub === 'messages') {
        this.requireUser(principal);
        const result = await this.submitUserMessage(conversationId, principal.username, body as never);
        return json(res, 200, result);
      }
      if (method === 'POST' && sub === 'cancel') {
        this.requireUser(principal);
        return json(res, 200, this.cancelConversation(conversationId));
      }
      throw new HttpError(404, 'not found');
    }

    // ---- files ----
    const fileMatch = path.match(/^\/api\/files\/([^/]+)$/);
    if (method === 'GET' && fileMatch) {
      return this.serveFile(decodeURIComponent(fileMatch[1]!), res);
    }

    // ---- dispatch requeue (user action) ----
    const requeueMatch = path.match(/^\/api\/dispatches\/([^/]+)\/requeue$/);
    if (method === 'POST' && requeueMatch) {
      this.requireUser(principal);
      return json(res, 200, this.requeueDispatch(decodeURIComponent(requeueMatch[1]!)));
    }

    // ---- agent API ----
    if (path.startsWith('/api/agent/')) {
      this.requireAgent(principal);
      return this.routeAgent(method, path, url, principal, body, res);
    }

    throw new HttpError(404, 'not found');
  }

  private handleLogin(res: ServerResponse, body: unknown): void {
    const input = body as { username?: string; password?: string };
    if (!input?.username || !input?.password) throw new HttpError(400, 'username and password are required');
    const user = this.store.getUser(input.username);
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw new HttpError(401, 'invalid credentials');
    }
    const token = newToken();
    this.store.createSession({
      tokenHash: tokenHash(token),
      username: user.username,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    });
    json(res, 200, { token, user: { username: user.username, displayName: user.displayName } });
  }

  private requireUser(principal: Principal): asserts principal is { kind: 'user'; username: string } {
    if (principal.kind !== 'user') throw new HttpError(403, 'agent credential cannot use the user API');
  }

  private requireAgent(principal: Principal): asserts principal is { kind: 'agent'; agentId: string } {
    if (principal.kind !== 'agent') throw new HttpError(403, 'user session cannot use the agent API');
  }

  private async routeAgent(
    method: string,
    path: string,
    url: URL,
    principal: { kind: 'agent'; agentId: string },
    body: unknown,
    res: ServerResponse,
  ): Promise<void> {
    const agentId = principal.agentId;

    if (method === 'POST' && path === '/api/agent/identity') {
      const input = body as { nodeId?: string; instanceId?: string; version?: string };
      this.hub.registerAgentIdentity(agentId, undefined, {
        ...(input?.nodeId ? { nodeId: input.nodeId } : {}),
        ...(input?.instanceId ? { instanceId: input.instanceId } : {}),
        ...(input?.version ? { version: input.version } : {}),
      });
      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && path === '/api/agent/dispatches') {
      const after = numberQuery(url, 'after');
      return json(res, 200, {
        dispatches: this.hub.listDispatches(agentId, after).map((dispatch) => ({
          ...dispatch,
          claimable: this.isClaimable(dispatch.id, dispatch.status),
        })),
      });
    }

    const claimMatch = path.match(/^\/api\/agent\/dispatches\/([^/]+)\/claim$/);
    if (method === 'POST' && claimMatch) {
      const input = body as { instanceId?: string };
      if (!input?.instanceId) throw new HttpError(400, 'instanceId is required');
      const result = await this.serialized(() =>
        this.claim(decodeURIComponent(claimMatch[1]!), agentId, input.instanceId!));
      return json(res, 200, result);
    }
    const heartbeatMatch = path.match(/^\/api\/agent\/dispatches\/([^/]+)\/heartbeat$/);
    if (method === 'POST' && heartbeatMatch) {
      const input = body as { attemptId?: string };
      if (!input?.attemptId) throw new HttpError(400, 'attemptId is required');
      return json(res, 200, this.heartbeat(decodeURIComponent(heartbeatMatch[1]!), agentId, input.attemptId!));
    }
    const releaseMatch = path.match(/^\/api\/agent\/dispatches\/([^/]+)\/release$/);
    if (method === 'POST' && releaseMatch) {
      const input = body as { attemptId?: string };
      if (!input?.attemptId) throw new HttpError(400, 'attemptId is required');
      return json(res, 200, this.release(decodeURIComponent(releaseMatch[1]!), agentId, input.attemptId!));
    }
    const completeMatch = path.match(/^\/api\/agent\/dispatches\/([^/]+)\/complete$/);
    if (method === 'POST' && completeMatch) {
      const input = body as { attemptId?: string; runId?: string; status?: 'completed' | 'failed' };
      if (!input?.attemptId || !input?.runId || !input?.status) {
        throw new HttpError(400, 'attemptId, runId and status are required');
      }
      const result = await this.serialized(() =>
        this.complete(decodeURIComponent(completeMatch[1]!), agentId, input.attemptId!, input.runId!, input.status!));
      return json(res, 200, result);
    }

    const contextMatch = path.match(/^\/api\/agent\/tasks\/([^/]+)\/context$/);
    if (method === 'GET' && contextMatch) {
      const taskId = decodeURIComponent(contextMatch[1]!);
      const task = this.hub.getTask(taskId);
      if (!task) throw new HttpError(404, 'task not found');
      return json(res, 200, {
        task,
        entries: this.hub.getContext(taskId, agentId, numberQuery(url, 'after')),
        artifacts: this.hub.getArtifacts(taskId, agentId),
      });
    }
    const promptMatch = path.match(/^\/api\/agent\/tasks\/([^/]+)\/prompt-context$/);
    if (method === 'GET' && promptMatch) {
      const taskId = decodeURIComponent(promptMatch[1]!);
      const dispatchId = requiredQuery(url, 'dispatchId');
      const task = this.hub.getTask(taskId);
      if (!task) throw new HttpError(404, 'task not found');
      const dispatch = this.hub.getDispatch(dispatchId);
      if (!dispatch || dispatch.taskId !== taskId) throw new HttpError(404, 'dispatch not found');
      if (dispatch.targetAgentId !== agentId) throw new HttpError(403, 'dispatch belongs to another agent');
      const conversationId = 'conversationId' in task.address ? task.address.conversationId : undefined;
      const hubArtifacts = this.hub.getArtifacts(taskId, agentId);
      const uploads = conversationId
        ? this.store.listConversationFiles(conversationId).map((file): SharedArtifact => ({
          id: file.id,
          name: file.name,
          kind: 'file',
          sha256: file.sha256,
          size: file.size,
          ...(file.mime ? { mime: file.mime } : {}),
          locator: { provider: 'object', uri: `api/files/${file.id}` },
        }))
        : [];
      return json(res, 200, {
        promptContext: buildLanCollaborationContext({
          deploymentId: this.config.deploymentId,
          task,
          dispatch,
          entries: this.hub.getContext(taskId, agentId),
          artifacts: [...hubArtifacts, ...uploads],
          agents: this.hub.listTaskAgentIdentities(taskId),
        }),
      });
    }

    if (method === 'POST' && path === '/api/agent/events') {
      const input = body as HubInput;
      this.authorizeAgentEvent(agentId, input);
      const result = await this.serialized(() => this.hub.submit(input));
      this.publishLedger(result.task.id);
      this.publishTask(result.task.id);
      return json(res, 200, result);
    }

    const runEventsMatch = path.match(/^\/api\/agent\/runs\/([^/]+)\/events$/);
    if (method === 'POST' && runEventsMatch) {
      const input = body as { conversationId?: string; taskId?: string; events?: LanRunEvent[] };
      if (!input?.conversationId || !input?.taskId || !Array.isArray(input?.events)) {
        throw new HttpError(400, 'conversationId, taskId and events[] are required');
      }
      const runId = decodeURIComponent(runEventsMatch[1]!);
      for (const event of input.events) {
        if (!LAN_RUN_EVENT_TYPES.has(event.type)) {
          throw new HttpError(400, `unknown run event type: ${(event as { type: string }).type}`);
        }
        if (event.runId !== runId) throw new HttpError(400, 'runId mismatch');
      }
      const records = this.store.appendRunEvents(input.conversationId, input.taskId, input.events);
      if (records.length > 0) {
        this.bus.publish({ conversationId: input.conversationId, kind: 'runs', runs: records });
      }
      return json(res, 200, { accepted: records.length });
    }

    const agentFileMatch = path.match(/^\/api\/agent\/files\/([^/]+)$/);
    if (method === 'GET' && agentFileMatch) {
      return this.serveFile(decodeURIComponent(agentFileMatch[1]!), res);
    }

    throw new HttpError(404, 'not found');
  }

  private authorizeAgentEvent(agentId: string, input: HubInput): void {
    if (input.type === 'message') {
      if (input.targetAgentIds.length > 0 && !input.targetAgentIds.includes(agentId)) {
        throw new HttpError(403, 'agent credential can only route a message that really mentioned itself');
      }
      return;
    }
    if (input.actorAgentId !== agentId) {
      throw new HttpError(403, 'agent credential cannot act as another agent');
    }
  }

  // ---- core operations ----

  private async submitUserMessage(
    conversationId: string,
    username: string,
    input: { content?: string; targetAgentIds?: string[]; idempotencyKey?: string },
  ): Promise<unknown> {
    if (!input?.content?.trim()) throw new HttpError(400, 'content is required');
    const user = this.store.getUser(username);
    const messageInput: HubInput = {
      type: 'message',
      idempotencyKey: input.idempotencyKey ?? `lan-user:${conversationId}:${randomUUID()}`,
      address: { deploymentId: this.config.deploymentId, conversationId },
      messageId: `lan-${randomUUID()}`,
      actor: { type: 'human', id: username, ...(user?.displayName ? { name: user.displayName } : {}) },
      content: input.content,
      targetAgentIds: input.targetAgentIds ?? [],
    };
    const result = await this.serialized(() => this.hub.submit(messageInput));
    this.publishLedger(result.task.id);
    this.publishTask(result.task.id);
    return { ...result, conversationId };
  }

  /** A dispatch is claimable when pending, or accepted but abandoned (released/uncertain attempt). */
  private isClaimable(dispatchId: string, status: string): boolean {
    if (status === 'pending') return true;
    if (status !== 'accepted') return false;
    const attempts = this.store.attemptsForDispatch(dispatchId);
    return !attempts.some((attempt) => attempt.state === 'active');
  }

  private async claim(dispatchId: string, agentId: string, instanceId: string): Promise<LanClaimResult> {
    const dispatch = this.hub.getDispatch(dispatchId);
    if (!dispatch) throw new HttpError(404, 'dispatch not found');
    if (dispatch.targetAgentId !== agentId) throw new HttpError(403, 'dispatch belongs to another agent');
    if (dispatch.status !== 'pending' && dispatch.status !== 'accepted') {
      throw new HttpError(409, `dispatch is ${dispatch.status}`);
    }
    const attempts = this.store.attemptsForDispatch(dispatchId);
    if (attempts.some((attempt) => attempt.state === 'active')) {
      throw new HttpError(409, 'dispatch already has an active attempt');
    }
    if (dispatch.status === 'pending') {
      await this.hub.acknowledge(dispatchId, agentId, 'accepted', `claim:${dispatchId}`);
    }
    const attemptId = `attempt_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    this.store.insertAttempt({
      id: attemptId,
      dispatchId,
      agentId,
      instanceId,
      claimedAt: now,
      heartbeatAt: now,
    });
    this.publishTask(dispatch.taskId);
    return { attemptId, dispatch: this.hub.getDispatch(dispatchId)! };
  }

  private heartbeat(dispatchId: string, agentId: string, attemptId: string): LanHeartbeatResult {
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt || attempt.dispatchId !== dispatchId || attempt.agentId !== agentId) {
      throw new HttpError(404, 'attempt not found');
    }
    if (attempt.state !== 'active') return { ok: false };
    this.store.touchAttemptHeartbeat(attemptId, new Date().toISOString());
    const dispatch = this.hub.getDispatch(dispatchId);
    const canceled = dispatch ? this.store.isTaskCanceled(dispatch.taskId) : false;
    return { ok: true, ...(canceled ? { canceled: true } : {}) };
  }

  private release(dispatchId: string, agentId: string, attemptId: string): { ok: boolean } {
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt || attempt.dispatchId !== dispatchId || attempt.agentId !== agentId) {
      throw new HttpError(404, 'attempt not found');
    }
    if (attempt.state === 'active') {
      this.store.setAttemptState(attemptId, 'released');
      const dispatch = this.hub.getDispatch(dispatchId);
      if (dispatch) this.publishTask(dispatch.taskId);
    }
    return { ok: true };
  }

  private async complete(
    dispatchId: string,
    agentId: string,
    attemptId: string,
    _runId: string,
    status: 'completed' | 'failed',
  ): Promise<{ dispatch: unknown; attemptId: string }> {
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt || attempt.dispatchId !== dispatchId || attempt.agentId !== agentId) {
      throw new HttpError(404, 'attempt not found');
    }
    if (attempt.state === status) {
      // Idempotent retry of an already-recorded completion.
      return { dispatch: this.hub.getDispatch(dispatchId), attemptId };
    }
    if (attempt.state !== 'active') {
      throw new HttpError(409, `attempt is ${attempt.state}; result is fenced`);
    }
    const dispatch = await this.hub.acknowledge(dispatchId, agentId, status, `${status}:${attemptId}`);
    this.store.setAttemptState(attemptId, status);
    this.publishTask(dispatch.taskId);
    return { dispatch, attemptId };
  }

  private requeueDispatch(dispatchId: string): { ok: boolean } {
    const dispatch = this.hub.getDispatch(dispatchId);
    if (!dispatch) throw new HttpError(404, 'dispatch not found');
    let changed = false;
    for (const attempt of this.store.attemptsForDispatch(dispatchId)) {
      if (attempt.state === 'active' || attempt.state === 'uncertain') {
        this.store.setAttemptState(attempt.id, 'fenced');
        changed = true;
      }
    }
    if (changed) this.publishTask(dispatch.taskId);
    return { ok: true };
  }

  private cancelConversation(conversationId: string): { ok: boolean } {
    const taskId = taskIdFor({ deploymentId: this.config.deploymentId, conversationId });
    this.store.setTaskCanceled(taskId);
    this.publishTask(taskId);
    return { ok: true };
  }

  private catchUp(conversationId: string, url: URL): LanCatchUpResult {
    const ledgerAfter = numberQuery(url, 'ledgerAfter');
    const runsAfter = numberQuery(url, 'runAfter');
    const ledger = this.store.ledgerRecordsForConversation(conversationId, ledgerAfter);
    const runs = this.store.runEventsAfter(conversationId, runsAfter);
    return {
      ledger,
      runs,
      cursor: {
        ledger: ledger.length > 0 ? ledger[ledger.length - 1]!.sequence : ledgerAfter,
        runs: runs.length > 0 ? runs[runs.length - 1]!.streamId : runsAfter,
      },
    };
  }

  // ---- SSE ----

  private handleStream(req: IncomingMessage, res: ServerResponse, conversationId: string, url: URL): void {
    if (!this.store.getConversation(conversationId)) {
      json(res, 404, { error: 'conversation not found' });
      return;
    }
    try {
      this.requireUser(this.authenticate(req, url));
    } catch {
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(':ok\n\n');

    const cursor = this.catchUp(conversationId, url);
    for (const record of cursor.ledger) res.write(`event: ledger\ndata: ${JSON.stringify(record)}\n\n`);
    for (const record of cursor.runs) res.write(`event: runs\ndata: ${JSON.stringify(record)}\n\n`);
    res.write(`event: cursor\ndata: ${JSON.stringify(cursor.cursor)}\n\n`);

    const unsubscribe = this.bus.subscribe(conversationId, (notification: LanConversationNotification) => {
      if (notification.kind === 'ledger' && notification.ledger) {
        for (const record of notification.ledger) res.write(`event: ledger\ndata: ${JSON.stringify(record)}\n\n`);
      } else if (notification.kind === 'runs' && notification.runs) {
        for (const record of notification.runs) res.write(`event: runs\ndata: ${JSON.stringify(record)}\n\n`);
      } else if (notification.kind === 'task' && notification.task) {
        res.write(`event: task\ndata: ${JSON.stringify(notification.task)}\n\n`);
      }
    });
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(':hb\n\n');
    }, 15_000);
    req.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  }

  // ---- files ----

  private async acceptUpload(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
    const nameHeader = req.headers['x-file-name'];
    const name = (Array.isArray(nameHeader) ? nameHeader[0] : nameHeader) ?? 'upload.bin';
    const mime = req.headers['content-type'] ?? 'application/octet-stream';
    const conversationHeader = req.headers['x-conversation-id'];
    const conversationId = Array.isArray(conversationHeader) ? conversationHeader[0] : conversationHeader;
    if (conversationId && !this.store.getConversation(conversationId)) {
      throw new HttpError(404, 'conversation not found');
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    const limit = this.config.fileMaxBytes ?? 256 * 1024 * 1024;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) throw new HttpError(413, 'file too large');
      chunks.push(buffer);
    }
    const content = Buffer.concat(chunks);
    const id = `file_${randomUUID().slice(0, 12)}`;
    const saved = await this.files.save({
      id,
      name,
      mime,
      content,
      uploadedBy: principal.kind === 'user' ? principal.username : principal.agentId,
      createdAt: new Date().toISOString(),
      ...(conversationId ? { conversationId } : {}),
    });
    this.store.saveFile({
      id,
      name: saved.name,
      mime: saved.mime,
      size: saved.size,
      sha256: saved.sha256,
      uploadedBy: saved.uploadedBy,
      createdAt: saved.createdAt,
      ...(conversationId ? { conversationId } : {}),
    });
    json(res, 200, { file: { id, name: saved.name, mime: saved.mime, size: saved.size, sha256: saved.sha256 } });
  }

  private serveFile(fileId: string, res: ServerResponse): void {
    const file = this.store.getFile(fileId);
    if (!file) {
      json(res, 404, { error: 'file not found' });
      return;
    }
    const absolutePath = join(this.files.rootDir(), file.sha256.slice(0, 2), file.sha256);
    if (!this.files.verify(absolutePath, file.sha256)) {
      json(res, 500, { error: 'stored file digest mismatch' });
      return;
    }
    res.writeHead(200, {
      'content-type': file.mime,
      'content-length': file.size,
      'x-file-sha256': file.sha256,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'cache-control': 'no-store',
    });
    const stream = this.files.openReadStream(absolutePath);
    stream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    stream.pipe(res);
  }

  // ---- static workbench ----

  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const webDir = this.config.webDir;
    if (!webDir || !existsSync(webDir)) {
      json(res, 404, { error: 'workbench not configured' });
      return;
    }
    const base = resolve(webDir);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const target = resolve(webDir, decodeURIComponent(relative));
    if (target !== base && !target.startsWith(base + '\\') && !target.startsWith(base + '/')) {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    let content: Buffer;
    let contentType: string;
    try {
      content = await readFile(target);
      contentType = contentTypeFor(target);
    } catch {
      // SPA fallback: unknown non-API paths render the app shell.
      try {
        content = await readFile(join(base, 'index.html'));
        contentType = 'text/html; charset=utf-8';
      } catch {
        json(res, 404, { error: 'not found' });
        return;
      }
    }
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': content.length,
      'cache-control': contentType.startsWith('text/html') ? 'no-store' : 'public, max-age=3600',
    });
    res.end(content);
  }
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.ico': return 'image/x-icon';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_JSON_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
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

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw new HttpError(400, `${key} is required`);
  return value;
}

function numberQuery(url: URL, key: string): number {
  const raw = url.searchParams.get(key);
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, `${key} must be a non-negative integer`);
  return parsed;
}
