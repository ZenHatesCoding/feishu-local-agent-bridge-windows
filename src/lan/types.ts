import type {
  AgentRegistration,
  CollaborationLedger,
  ContextVisibility,
  Dispatch,
  HubInput,
  HubResult,
  LedgerRecord,
  TaskAddress,
} from '../collab/types';

/**
 * Channel-neutral LAN collaboration contract.
 *
 * The center owns the same deterministic state machine as the Feishu Hub
 * (CollaborationHub), backed by SQLite instead of a JSONL file, and adds the
 * pieces the Feishu channel got for free from the messenger: user accounts,
 * a browser entry point (SSE), authorized file delivery and worker
 * claim/lease semantics.
 */

/** Task lifecycle exposed to the workbench, aligned with the A2A TaskState vocabulary. */
export type LanTaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected';

/** Run progress stream taxonomy, aligned with the AG-UI event vocabulary. */
export type LanRunEvent =
  | { type: 'RUN_STARTED'; runId: string; taskId: string; dispatchId: string; agentId: string; at: string }
  | { type: 'RUN_STATUS'; runId: string; message: string; at: string }
  | { type: 'TEXT_MESSAGE_CONTENT'; runId: string; delta: string; at: string }
  | { type: 'TOOL_CALL_STARTED'; runId: string; callId: string; name: string; at: string }
  | { type: 'TOOL_CALL_RESULT'; runId: string; callId: string; summary: string; isError: boolean; at: string }
  | { type: 'RUN_FINISHED'; runId: string; status: 'completed' | 'failed'; at: string }
  | { type: 'RUN_ERROR'; runId: string; message: string; at: string };

export const LAN_RUN_EVENT_TYPES: ReadonlySet<LanRunEvent['type']> = new Set([
  'RUN_STARTED',
  'RUN_STATUS',
  'TEXT_MESSAGE_CONTENT',
  'TOOL_CALL_STARTED',
  'TOOL_CALL_RESULT',
  'RUN_FINISHED',
  'RUN_ERROR',
]);

export type LanRunEventRecord = LanRunEvent & {
  /** Global monotonic id of the run-event stream; safe as a resume cursor. */
  streamId: number;
  conversationId: string;
  taskId: string;
};

export interface LanStoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  uploadedBy: string;
  createdAt: string;
  /** Set for files uploaded into a conversation; exposed to task participants. */
  conversationId?: string;
}

export interface LanConversation {
  id: string;
  title: string;
  createdAt: string;
  createdBy: string;
  /** Derived workbench state for the conversation's task. */
  state: LanTaskState;
  ownerAgentId?: string;
  lastActivityAt: string;
}

export interface LanSessionUser {
  username: string;
  displayName: string;
}

/** One scripted step of a fake agent run. */
export interface LanFakeAgentStep {
  delayMs?: number;
  /** Progress status line (no answer content). */
  status?: string;
  /** Streaming answer delta. */
  text?: string;
  tool?: { id: string; name: string; input?: unknown; result: string; isError?: boolean };
  finalText?: string;
}

export interface LanFakeAgentScript {
  steps: LanFakeAgentStep[];
}

export type LanWorkerRuntime =
  | { kind: 'fake'; script?: LanFakeAgentStep[] }
  | { kind: 'codex'; binary?: string; profileStateDir?: string; cwd?: string; model?: string; sandbox?: string }
  | { kind: 'claude'; binary?: string; cwd?: string; model?: string; permissionMode?: string };

export interface LanCenterConfig {
  deploymentId: string;
  dataDir: string;
  listen: { host: string; port: number };
  users: Array<{ username: string; displayName?: string; password?: string; passwordHash?: string }>;
  agents: AgentRegistration[];
  leaseMinutes?: number;
  maxCausalDepth?: number;
  maxConversationTurns?: number;
  /** An active attempt whose heartbeat is older than this is marked uncertain. */
  heartbeatTimeoutMs?: number;
  fileMaxBytes?: number;
  /** Directory with the built workbench assets; served at `/` when present. */
  webDir?: string;
}

export interface LanWorkerConfig {
  centerUrl: string;
  agent: { id: string; displayName: string };
  token?: string;
  tokenFile?: string;
  runtime: LanWorkerRuntime;
  nodeId: string;
  instanceId?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

/** Payload accepted by POST /api/conversations/:id/messages. */
export interface LanUserMessageInput {
  content: string;
  targetAgentIds?: string[];
  /** Files uploaded through /api/files and attached to this message. */
  attachments?: Array<{ fileId: string }>;
  visibility?: ContextVisibility;
  idempotencyKey?: string;
}

export interface LanMessageResult extends HubResult {
  conversationId: string;
}

export interface LanClaimResult {
  attemptId: string;
  dispatch: Dispatch;
}

export interface LanHeartbeatResult {
  ok: boolean;
  /** Set when a user canceled the task; the worker should stop gracefully. */
  canceled?: boolean;
}

export interface LanCatchUpResult {
  ledger: LedgerRecord[];
  runs: LanRunEventRecord[];
  cursor: { ledger: number; runs: number };
}

export interface LanCenterSnapshot {
  deploymentId: string;
  conversationCount: number;
  ledgerRecords: number;
}

/** Durable state store for the LAN center. One SQLite database per deployment. */
export interface LanStore extends CollaborationLedger {
  close(): void;

  // conversations
  createConversation(input: { id: string; title: string; createdBy: string; createdAt: string }): void;
  listConversations(): Array<{ id: string; title: string; createdAt: string; createdBy: string }>;
  getConversation(id: string): { id: string; title: string; createdAt: string; createdBy: string } | undefined;

  // users & sessions
  upsertUser(input: { username: string; displayName: string; passwordHash: string }): void;
  getUser(username: string): { username: string; displayName: string; passwordHash: string } | undefined;
  createSession(input: { tokenHash: string; username: string; createdAt: string; expiresAt: string }): void;
  getSession(tokenHash: string): { username: string; expiresAt: string } | undefined;
  deleteSession(tokenHash: string): void;

  // agent credentials
  getAgentToken(agentId: string): string | undefined;
  setAgentToken(agentId: string, tokenHash: string): void;

  // files
  saveFile(input: LanStoredFile): void;
  getFile(id: string): LanStoredFile | undefined;
  listConversationFiles(conversationId: string): LanStoredFile[];

  // attempts (claim/lease bookkeeping; the dispatch state machine stays in the Hub)
  insertAttempt(input: {
    id: string;
    dispatchId: string;
    agentId: string;
    instanceId: string;
    claimedAt: string;
    heartbeatAt: string;
  }): void;
  getAttempt(id: string): { id: string; dispatchId: string; agentId: string; instanceId: string; state: string; claimedAt: string; heartbeatAt: string } | undefined;
  attemptsForDispatch(dispatchId: string): Array<{ id: string; state: string; agentId: string; instanceId: string; claimedAt: string; heartbeatAt: string }>;
  touchAttemptHeartbeat(id: string, at: string): void;
  setAttemptState(id: string, state: LanAttemptState): void;
  listAttempts(input: { state?: LanAttemptState }): Array<{
    id: string;
    dispatchId: string;
    agentId: string;
    instanceId: string;
    state: string;
    heartbeatAt: string;
  }>;

  // run progress stream
  appendRunEvents(conversationId: string, taskId: string, events: LanRunEvent[]): LanRunEventRecord[];
  runEventsAfter(conversationId: string, afterStreamId: number, limit?: number): LanRunEventRecord[];

  // ledger with conversation projection
  ledgerRecordsForConversation(conversationId: string, afterSequence: number): LedgerRecord[];
  ledgerTail(limit: number): LedgerRecord[];

  // task-level cancellation flags (the Hub has no cancel state; this is center-owned)
  setTaskCanceled(taskId: string): void;
  isTaskCanceled(taskId: string): boolean;

  metaGet(key: string): string | undefined;
  metaSet(key: string, value: string): void;
}

export type LanAttemptState = 'active' | 'released' | 'uncertain' | 'fenced' | 'completed' | 'failed';

/** Hub-facing input types re-exported for the LAN API layer. */
export type { HubInput, HubResult, LedgerRecord, TaskAddress, Dispatch };

export function lanAddressFor(deploymentId: string, conversationId: string): TaskAddress {
  return { deploymentId, conversationId };
}

/** Derive the conversation id of a task from its address; undefined for foreign addresses. */
export function conversationIdOf(address: TaskAddress, deploymentId: string): string | undefined {
  return 'conversationId' in address && address.deploymentId === deploymentId
    ? address.conversationId
    : undefined;
}
