export type AgentId = string;

export type ContextVisibility =
  | { kind: 'task-public' }
  | { kind: 'handoff'; from: AgentId; to: AgentId }
  | { kind: 'targeted'; agents: AgentId[] }
  | { kind: 'private-runtime'; agent: AgentId }
  | { kind: 'secret' };

export interface TaskAddress {
  tenantKey: string;
  chatId: string;
  threadId: string;
}

export interface AgentRegistration {
  id: AgentId;
  displayName: string;
  aliases?: string[];
}

/** Runtime-only Feishu identity, registered by a connected bridge. */
export interface AgentIdentity {
  id: AgentId;
  displayName: string;
  openId: string;
  nodeId?: string;
  instanceId?: string;
  version?: string;
  lastSeenAt?: string;
}

export type ArtifactLocator =
  | { provider: 'local'; path: string; nodeId?: string }
  | { provider: 'feishu'; messageId: string; fileKey: string }
  | { provider: 'git'; repository: string; commit: string; path?: string }
  | { provider: 'object'; uri: string };

export interface MessageInput {
  type: 'message';
  idempotencyKey: string;
  address: TaskAddress;
  messageId: string;
  actor: { type: 'human' | 'agent'; id: string; name?: string };
  content: string;
  targetAgentIds: AgentId[];
  visibility?: ContextVisibility;
  references?: string[];
  occurredAt?: string;
}

export interface ActionInput {
  type: 'handoff' | 'ask' | 'return' | 'complete';
  idempotencyKey: string;
  taskId: string;
  actorAgentId: AgentId;
  /** Dispatch whose active agent run caused this action. */
  causedByDispatchId: string;
  targetAgentId?: AgentId;
  content: string;
  references?: string[];
  occurredAt?: string;
}

export interface SharedArtifact {
  id: string;
  name: string;
  kind: string;
  /** Node-local cache path. It is never the cross-node source of truth. */
  localPath?: string;
  /** Portable location from which another node can obtain this artifact. */
  locator?: ArtifactLocator;
  sha256: string;
  size: number;
  mime?: string;
  sourceMessageId?: string;
  sourceFileKey?: string;
}

export interface ArtifactInput {
  type: 'artifact';
  idempotencyKey: string;
  taskId: string;
  actorAgentId: AgentId;
  artifact: SharedArtifact;
  visibility?: Exclude<ContextVisibility, { kind: 'secret' }>;
  occurredAt?: string;
}

export type HubInput = MessageInput | ActionInput | ArtifactInput;

export type LedgerEvent =
  | {
      kind: 'message';
      messageId: string;
      actor: MessageInput['actor'];
      content: string;
      targetAgentIds: AgentId[];
      visibility: ContextVisibility;
      references: string[];
      occurredAt: string;
    }
  | {
      kind: 'lease';
      ownerAgentId: AgentId;
      reason: 'mention' | 'handoff';
      expiresAt: string;
    }
  | {
      kind: 'action';
      action: ActionInput['type'];
      actorAgentId: AgentId;
      targetAgentId?: AgentId;
      content: string;
      references: string[];
      occurredAt: string;
      visibility: ContextVisibility;
      causedByDispatchId: string;
    }
  | {
      kind: 'artifact';
      actorAgentId: AgentId;
      artifact: SharedArtifact;
      occurredAt: string;
      visibility: Exclude<ContextVisibility, { kind: 'secret' }>;
    }
  | {
      kind: 'dispatch';
      dispatchId: string;
      targetAgentId: AgentId;
      reason: 'assign' | 'fanout' | 'handoff' | 'ask' | 'return';
      objective: string;
      sourceSequence: number;
      parentDispatchId?: string;
      /** Depth in the current causal dispatch chain. Human assignments start at 1. */
      hop: number;
    }
  | {
      kind: 'ack';
      dispatchId: string;
      agentId: AgentId;
      status: 'accepted' | 'completed' | 'failed';
    }
  | { kind: 'task-completed'; byAgentId: AgentId; summary: string };

export interface LedgerRecord {
  sequence: number;
  idempotencyKey: string;
  taskId: string;
  address?: TaskAddress;
  recordedAt: string;
  event: LedgerEvent;
}

export interface Dispatch {
  id: string;
  sequence: number;
  taskId: string;
  targetAgentId: AgentId;
  reason: 'assign' | 'fanout' | 'handoff' | 'ask' | 'return';
  objective: string;
  sourceSequence: number;
  parentDispatchId?: string;
  /** Depth in the current causal dispatch chain. Human assignments start at 1. */
  hop: number;
  status: 'pending' | 'accepted' | 'completed' | 'failed';
}

export interface TaskProjection {
  id: string;
  address: TaskAddress;
  status: 'open' | 'completed';
  ownerAgentId?: AgentId;
  leaseExpiresAt?: string;
  participants: AgentId[];
  lastSequence: number;
}

export interface ContextEntry {
  sequence: number;
  recordedAt: string;
  event: LedgerEvent;
}

export interface HubResult {
  task: TaskProjection;
  dispatches: Dispatch[];
  duplicate: boolean;
}
