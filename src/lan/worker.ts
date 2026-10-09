import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import { ClaudeAdapter } from '../agent/claude/adapter';
import { CodexAdapter } from '../agent/codex/adapter';
import { extractCollaborationHandoff } from '../collab/bridge-adapter';
import type { HubInput } from '../collab/types';
import type {
  LanClaimResult,
  LanRunEvent,
  LanWorkerConfig,
  LanWorkerRuntime,
} from './types';
import { FakeAgentAdapter } from './fake-agent';

const RUN_EVENT_FLUSH_MS = 200;
const RUN_EVENT_BATCH_LIMIT = 64;

interface PendingDispatch {
  id: string;
  taskId: string;
  targetAgentId: string;
  reason: string;
  objective: string;
  status: string;
  sequence: number;
}

/**
 * A LAN worker: one long-running agent endpoint that registers with the
 * center, claims dispatches, runs the agent (real CLI or fake), streams
 * progress, submits structured collaboration actions and finalizes attempts.
 */
export class LanWorker {
  private stopped = false;
  private pollTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly token: string;
  private readonly adapter: AgentAdapter;
  private readonly instanceId: string;
  private activeRun: {
    dispatch: PendingDispatch;
    attemptId: string;
    runId: string;
    cancelRequested: boolean;
  } | undefined;

  constructor(readonly config: LanWorkerConfig) {
    this.token = config.token ?? '';
    this.instanceId = config.instanceId ?? `inst_${randomUUID().slice(0, 8)}`;
    this.adapter = createAdapter(config.runtime);
  }

  private get base(): string {
    return this.config.centerUrl.replace(/\/$/, '');
  }

  async start(): Promise<void> {
    if (!this.token) throw new Error('worker token is required (token or tokenFile)');
    await this.api('POST', '/api/agent/identity', {
      nodeId: this.config.nodeId,
      instanceId: this.instanceId,
      version: process.env.npm_package_version,
    });
    this.pollTimer = setInterval(() => void this.poll(), this.config.pollIntervalMs ?? 1000);
    this.pollTimer.unref();
    await this.poll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.activeRun) {
      this.activeRun.cancelRequested = true;
    }
    // Give the active run a moment to unwind through the cancel path.
    for (let i = 0; i < 100 && this.activeRun; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.activeRun) return;
    try {
      const result = await this.api<{ dispatches: Array<PendingDispatch & { claimable?: boolean }> }>(
        'GET',
        `/api/agent/dispatches?after=${this.dispatchCursor}`,
      );
      for (const dispatch of result.dispatches) {
        this.dispatchCursor = Math.max(this.dispatchCursor, dispatch.sequence);
        // 'claimable' covers pending dispatches and accepted ones whose
        // attempt was released or timed out (uncertain) — both are safe to
        // claim; anything else (completed/failed or actively running) is not.
        if (!dispatch.claimable || this.stopped) continue;
        await this.runDispatch(dispatch);
        if (this.stopped) return;
      }
    } catch (err) {
      if (!this.stopped) {
        console.error(`[lan-worker:${this.config.agent.id}] poll failed: ${(err as Error).message}`);
      }
    }
  }

  private dispatchCursor = 0;

  private async runDispatch(dispatch: PendingDispatch): Promise<void> {
    let claim: LanClaimResult;
    try {
      claim = await this.api<LanClaimResult>('POST', `/api/agent/dispatches/${dispatch.id}/claim`, {
        instanceId: this.instanceId,
      });
    } catch (err) {
      console.error(`[lan-worker:${this.config.agent.id}] claim failed for ${dispatch.id}: ${(err as Error).message}`);
      return;
    }
    const runId = `run_${randomUUID().slice(0, 12)}`;
    const run = { dispatch, attemptId: claim.attemptId, runId, cancelRequested: false };
    this.activeRun = run;

    const conversationId = await this.resolveConversationId(dispatch.taskId).catch(() => undefined);
    const events: LanRunEvent[] = [];
    let flushTimer: NodeJS.Timeout | undefined;
    const flush = async (): Promise<void> => {
      if (events.length === 0) return;
      const batch = events.splice(0, events.length);
      try {
        await this.api('POST', `/api/agent/runs/${runId}/events`, {
          ...(conversationId ? { conversationId } : {}),
          taskId: dispatch.taskId,
          events: batch,
        });
      } catch (err) {
        console.error(`[lan-worker:${this.config.agent.id}] run event flush failed: ${(err as Error).message}`);
      }
    };
    const emit = (event: LanRunEvent): void => {
      events.push(event);
      if (events.length >= RUN_EVENT_BATCH_LIMIT) {
        void flush();
        return;
      }
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          void flush();
        }, RUN_EVENT_FLUSH_MS);
        flushTimer.unref();
      }
    };
    const now = (): string => new Date().toISOString();

    // Heartbeat loop for this attempt.
    const heartbeatInterval = this.config.heartbeatIntervalMs ?? 20_000;
    const heartbeat = setInterval(() => void (async () => {
      try {
        const result = await this.api<{ ok: boolean; canceled?: boolean }>(
          'POST',
          `/api/agent/dispatches/${dispatch.id}/heartbeat`,
          { attemptId: claim.attemptId },
        );
        if (result.canceled) run.cancelRequested = true;
        if (!result.ok && !run.cancelRequested) {
          // Attempt was fenced or marked uncertain; stop silently.
          run.cancelRequested = true;
        }
      } catch {
        // Transient network errors are tolerated; the next beat retries.
      }
    })(), heartbeatInterval);
    heartbeat.unref();

    try {
      emit({ type: 'RUN_STARTED', runId, taskId: dispatch.taskId, dispatchId: dispatch.id, agentId: this.config.agent.id, at: now() });
      const context = await this.api<{ promptContext: string }>(
        'GET',
        `/api/agent/tasks/${dispatch.taskId}/prompt-context?dispatchId=${dispatch.id}`,
      );
      const prompt = `${context.promptContext}\n\n# Task\n\n${dispatch.objective}`;
      emit({ type: 'RUN_STATUS', runId, message: 'context ready, starting the agent', at: now() });

      const cwd = this.runtimeCwd();
      const agentRun = this.adapter.run({ runId, prompt, ...(cwd ? { cwd } : {}) });
      let answer = '';
      let termination: 'completed' | 'failed' = 'failed';
      for await (const event of agentRun.events) {
        if (run.cancelRequested) {
          await agentRun.stop();
        }
        this.forwardAgentEvent(event, emit, runId, (delta) => {
          answer += delta;
        });
        if (event.type === 'done') {
          termination = event.terminationReason === 'normal' ? 'completed' : 'failed';
        }
        if (event.type === 'error') {
          termination = 'failed';
          emit({ type: 'RUN_ERROR', runId, message: event.message, at: now() });
        }
      }

      const visible = extractCollaborationHandoff(answer);
      if (termination === 'completed') {
        await this.submitDelegations(visible, dispatch, runId);
        const hasContent = visible.visibleContent.trim().length > 0;
        // Every successful turn with content records a return action; the
        // Hub turns it into a wake-up dispatch for the owner when (and only
        // when) this run answered an ask.
        if (hasContent) {
          await this.submitAction({
            type: 'return',
            idempotencyKey: `lan-return:${this.config.agent.id}:${runId}`,
            taskId: dispatch.taskId,
            actorAgentId: this.config.agent.id,
            causedByDispatchId: dispatch.id,
            content: visible.visibleContent,
          });
        }
      }
      emit({ type: 'RUN_FINISHED', runId, status: termination, at: now() });
      await flush();
      await this.completeAttempt(dispatch, claim.attemptId, runId, termination);
    } catch (err) {
      emit({ type: 'RUN_ERROR', runId, message: (err as Error).message, at: now() });
      emit({ type: 'RUN_FINISHED', runId, status: 'failed', at: now() });
      await flush();
      await this.completeAttempt(dispatch, claim.attemptId, runId, 'failed');
    } finally {
      clearInterval(heartbeat);
      if (flushTimer) clearTimeout(flushTimer);
      await flush().catch(() => undefined);
      this.activeRun = undefined;
    }
  }

  private forwardAgentEvent(
    event: AgentEvent,
    emit: (event: LanRunEvent) => void,
    runId: string,
    onText: (delta: string) => void,
  ): void {
    const now = (): string => new Date().toISOString();
    switch (event.type) {
      case 'text':
        onText(event.delta);
        emit({ type: 'TEXT_MESSAGE_CONTENT', runId, delta: event.delta, at: now() });
        return;
      case 'activity':
        if (event.summary) emit({ type: 'RUN_STATUS', runId, message: event.summary, at: now() });
        return;
      case 'tool_use':
        emit({ type: 'TOOL_CALL_STARTED', runId, callId: event.id, name: event.name, at: now() });
        return;
      case 'tool_result':
        emit({
          type: 'TOOL_CALL_RESULT',
          runId,
          callId: event.id,
          summary: event.output.slice(0, 400),
          isError: event.isError,
          at: now(),
        });
        return;
      default:
        // system, thinking (never shared), usage, done and error are handled
        // by the caller or intentionally not forwarded.
        return;
    }
  }

  private async submitDelegations(
    visible: ReturnType<typeof extractCollaborationHandoff>,
    dispatch: PendingDispatch,
    runId: string,
  ): Promise<void> {
    const intents = [
      visible.handoff ? { type: 'handoff' as const, intent: visible.handoff } : undefined,
      visible.reply ? { type: 'reply' as const, intent: visible.reply } : undefined,
      visible.ask ? { type: 'ask' as const, intent: visible.ask } : undefined,
    ].filter(Boolean) as Array<{ type: 'handoff' | 'reply' | 'ask'; intent: { targetAgentId: string; content: string } }>;
    for (const { type, intent } of intents) {
      await this.submitAction({
        type,
        idempotencyKey: `lan-${type}:${this.config.agent.id}:${runId}:${intent.targetAgentId}`,
        taskId: dispatch.taskId,
        actorAgentId: this.config.agent.id,
        causedByDispatchId: dispatch.id,
        targetAgentId: intent.targetAgentId,
        content: intent.content,
      });
    }
  }

  private async submitAction(input: HubInput): Promise<void> {
    try {
      await this.api('POST', '/api/agent/events', input);
    } catch (err) {
      console.error(
        `[lan-worker:${this.config.agent.id}] ${input.type} submit failed: ${(err as Error).message}`,
      );
    }
  }

  private async completeAttempt(
    dispatch: PendingDispatch,
    attemptId: string,
    runId: string,
    status: 'completed' | 'failed',
  ): Promise<void> {
    try {
      await this.api('POST', `/api/agent/dispatches/${dispatch.id}/complete`, {
        attemptId,
        runId,
        status,
      });
    } catch (err) {
      // A fenced attempt rejects completion by design; nothing to redo here.
      console.error(
        `[lan-worker:${this.config.agent.id}] complete failed for ${dispatch.id}: ${(err as Error).message}`,
      );
    }
  }

  private async resolveConversationId(taskId: string): Promise<string | undefined> {
    try {
      const context = await this.api<{ task: { address: { conversationId?: string } } }>(
        'GET',
        `/api/agent/tasks/${taskId}/context`,
      );
      return context.task.address.conversationId;
    } catch {
      return undefined;
    }
  }

  private runtimeCwd(): string | undefined {
    const runtime = this.config.runtime;
    return runtime.kind === 'codex' || runtime.kind === 'claude' ? runtime.cwd : undefined;
  }

  private async api<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) as { error?: string } & Record<string, unknown> : {};
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${parsed.error ?? response.statusText}`);
    }
    return parsed as T;
  }
}

function createAdapter(runtime: LanWorkerRuntime): AgentAdapter {
  switch (runtime.kind) {
    case 'fake':
      return new FakeAgentAdapter({ script: runtime.script ? { steps: runtime.script } : undefined });
    case 'codex':
      return new CodexAdapter({
        binary: runtime.binary ?? 'codex',
        profileStateDir: runtime.profileStateDir ?? join(tmpdir(), `lan-worker-codex-${process.pid}`),
      });
    case 'claude':
      return new ClaudeAdapter(runtime.binary ? { binary: runtime.binary } : {});
    default:
      throw new Error(`unknown worker runtime: ${(runtime as { kind: string }).kind}`);
  }
}

/** Load a worker config JSON file, resolving the token file if needed. */
export async function loadWorkerConfig(path: string): Promise<LanWorkerConfig> {
  const config = JSON.parse(await readFile(path, 'utf8')) as LanWorkerConfig;
  if (!config.token && config.tokenFile) {
    const token = (await readFile(config.tokenFile, 'utf8')).trim();
    if (!token) throw new Error(`token file is empty: ${config.tokenFile}`);
    config.token = token;
  }
  if (!config.token) throw new Error('worker config needs a token or tokenFile');
  return config;
}
