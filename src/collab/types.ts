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
  targetAgentId?: AgentId;
  content: string;
  references?: string[];
  occurredAt?: string;
}

export type HubInput = MessageInput | ActionInput;

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
    }
  | {
      kind: 'dispatch';
      dispatchId: string;
      targetAgentId: AgentId;
      reason: 'assign' | 'fanout' | 'handoff' | 'ask' | 'return';
      objective: string;
      sourceSequence: number;
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
  lastDispatchHop: number;
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
