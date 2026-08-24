import { randomUUID } from 'node:crypto';
import { taskIdFor } from './task-id';
import type {
  ActionInput,
  ArtifactInput,
  AgentId,
  AgentRegistration,
  ContextEntry,
  ContextVisibility,
  Dispatch,
  HubInput,
  HubResult,
  LedgerEvent,
  LedgerRecord,
  MessageInput,
  SharedArtifact,
  TaskProjection,
} from './types';
import { JsonlLedger } from './ledger';

export interface CollaborationHubOptions {
  agents: AgentRegistration[];
  leaseMs?: number;
  maxHops?: number;
  now?: () => Date;
  idFactory?: () => string;
}

export class CollaborationHub {
  private readonly records: LedgerRecord[] = [];
  private readonly tasks = new Map<string, TaskProjection>();
  private readonly dispatches = new Map<string, Dispatch>();
  private readonly idempotency = new Map<string, string>();
  private readonly agents: Map<string, AgentRegistration>;
  private readonly leaseMs: number;
  private readonly maxHops: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ledger: JsonlLedger, options: CollaborationHubOptions) {
    this.agents = new Map(options.agents.map((agent) => [agent.id, agent]));
    this.leaseMs = options.leaseMs ?? 30 * 60_000;
    this.maxHops = options.maxHops ?? 8;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    if (this.agents.size !== options.agents.length) throw new Error('agent ids must be unique');
  }

  async initialize(): Promise<void> {
    const records = await this.ledger.readAll();
    for (const record of records) this.apply(record);
  }

  submit(input: HubInput): Promise<HubResult> {
    return this.serialized(() => this.submitInternal(input));
  }

  acknowledge(
    dispatchId: string,
    agentId: string,
    status: 'accepted' | 'completed' | 'failed',
    idempotencyKey: string,
  ): Promise<Dispatch> {
    return this.serialized(async () => {
      const dispatch = this.dispatches.get(dispatchId);
      if (!dispatch) throw new Error(`dispatch not found: ${dispatchId}`);
      if (dispatch.targetAgentId !== agentId) throw new Error('dispatch belongs to another agent');
      if (this.idempotency.has(idempotencyKey)) return { ...dispatch };
      const record = this.record(idempotencyKey, dispatch.taskId, {
        kind: 'ack', dispatchId, agentId, status,
      });
      await this.commit([record]);
      return { ...this.dispatches.get(dispatchId)! };
    });
  }

  getTask(taskId: string): TaskProjection | undefined {
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : undefined;
  }

  listDispatches(agentId: string, afterSequence = 0): Dispatch[] {
    this.requireAgent(agentId);
    return [...this.dispatches.values()]
      .filter((item) => item.targetAgentId === agentId && item.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence)
      .map((item) => ({ ...item }));
  }

  getContext(taskId: string, agentId: string, afterSequence = 0): ContextEntry[] {
    this.requireAgent(agentId);
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (!task.participants.includes(agentId)) throw new Error('agent is not a task participant');
    return this.records
      .filter((record) => record.taskId === taskId && record.sequence > afterSequence)
      .filter((record) => canSee(record.event, agentId))
      .map((record) => ({
        sequence: record.sequence,
        recordedAt: record.recordedAt,
        event: structuredClone(record.event),
      }));
  }

  getArtifacts(taskId: string, agentId: string): SharedArtifact[] {
    const artifacts = new Map<string, SharedArtifact>();
    for (const entry of this.getContext(taskId, agentId)) {
      if (entry.event.kind === 'artifact') {
        artifacts.set(entry.event.artifact.id, structuredClone(entry.event.artifact));
      }
    }
    return [...artifacts.values()];
  }

  private async submitInternal(input: HubInput): Promise<HubResult> {
    this.validateInput(input);
    const previousTaskId = this.idempotency.get(input.idempotencyKey);
    if (previousTaskId) {
      const task = this.tasks.get(previousTaskId);
      if (!task) throw new Error('idempotency index references a missing task');
      const sourceRecord = this.records.find((record) => record.idempotencyKey === input.idempotencyKey);
      const dispatches = sourceRecord
        ? [...this.dispatches.values()]
            .filter((dispatch) => dispatch.taskId === previousTaskId && dispatch.sourceSequence === sourceRecord.sequence)
            .map((dispatch) => ({ ...dispatch }))
        : [];
      return { task: cloneTask(task), dispatches, duplicate: true };
    }

    const taskId = input.type === 'message' ? taskIdFor(input.address) : input.taskId;
    const task = this.tasks.get(taskId);
    if (input.type !== 'message' && !task) throw new Error(`task not found: ${taskId}`);
    if (task?.status === 'completed' && input.type !== 'message') {
      throw new Error(`task is already completed: ${taskId}`);
    }

    const records = input.type === 'message'
      ? this.recordsForMessage(taskId, input)
      : input.type === 'artifact'
        ? this.recordsForArtifact(task!, input)
        : this.recordsForAction(task!, input);
    await this.commit(records);
    const resultTask = this.tasks.get(taskId);
    if (!resultTask) throw new Error('task projection was not created');
    const createdDispatches = records
      .map((record) => record.event.kind === 'dispatch' ? this.dispatches.get(record.event.dispatchId) : undefined)
      .filter((dispatch): dispatch is Dispatch => Boolean(dispatch))
      .map((dispatch) => ({ ...dispatch }));
    return { task: cloneTask(resultTask), dispatches: createdDispatches, duplicate: false };
  }

  private recordsForMessage(taskId: string, input: MessageInput): LedgerRecord[] {
    const now = input.occurredAt ?? this.now().toISOString();
    const visibility = input.visibility ?? { kind: 'task-public' };
    const message = this.record(input.idempotencyKey, taskId, {
      kind: 'message',
      messageId: input.messageId,
      actor: input.actor,
      content: input.content,
      targetAgentIds: [...new Set(input.targetAgentIds)],
      visibility,
      references: input.references ?? [],
      occurredAt: now,
    }, input.address);
    const records = [message];

    if (input.actor.type !== 'human' || input.targetAgentIds.length === 0) return records;
    const targets = [...new Set(input.targetAgentIds)];
    if (targets.length === 1) {
      const target = targets[0]!;
      records.push(this.record(`${input.idempotencyKey}:lease`, taskId, {
        kind: 'lease', ownerAgentId: target, reason: 'mention', expiresAt: this.leaseExpiry(),
      }));
      records.push(this.dispatchRecord(input.idempotencyKey, taskId, target, 'assign', input.content, message.sequence, 1));
    } else {
      for (const target of targets) {
        records.push(this.dispatchRecord(input.idempotencyKey, taskId, target, 'fanout', input.content, message.sequence, 1));
      }
    }
    return records;
  }

  private recordsForAction(task: TaskProjection, input: ActionInput): LedgerRecord[] {
    this.requireAgent(input.actorAgentId);
    if (!task.participants.includes(input.actorAgentId)) {
      throw new Error('only a task participant may submit an action');
    }
    const activeOwner = task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) > this.now().getTime()
      ? task.ownerAgentId
      : undefined;
    if (input.type === 'handoff' || input.type === 'ask') {
      if (activeOwner !== input.actorAgentId) {
        throw new Error(`only the current owner (${activeOwner ?? 'none'}) may ${input.type}`);
      }
      if (!input.targetAgentId) throw new Error(`${input.type} requires targetAgentId`);
      this.requireAgent(input.targetAgentId);
      if (input.targetAgentId === input.actorAgentId) throw new Error('an agent cannot target itself');
    }

    const nextHop = task.lastDispatchHop + 1;
    if ((input.type === 'handoff' || input.type === 'ask' || input.type === 'return') && nextHop > this.maxHops) {
      throw new Error(`maximum collaboration hops exceeded (${this.maxHops})`);
    }
    if (input.type === 'complete' && activeOwner !== input.actorAgentId) {
      throw new Error(`only the current owner (${activeOwner ?? 'none'}) may complete the task`);
    }
    const occurredAt = input.occurredAt ?? this.now().toISOString();
    const visibility: ContextVisibility = input.type === 'handoff' && input.targetAgentId
      ? { kind: 'handoff', from: input.actorAgentId, to: input.targetAgentId }
      : input.type === 'ask' && input.targetAgentId
        ? { kind: 'targeted', agents: [input.actorAgentId, input.targetAgentId] }
        : { kind: 'task-public' };
    const action = this.record(input.idempotencyKey, task.id, {
      kind: 'action',
      action: input.type,
      actorAgentId: input.actorAgentId,
      ...(input.targetAgentId ? { targetAgentId: input.targetAgentId } : {}),
      content: input.content,
      references: input.references ?? [],
      occurredAt,
      visibility,
    });
    const records = [action];
    if (input.type === 'handoff') {
      records.push(this.record(`${input.idempotencyKey}:lease`, task.id, {
        kind: 'lease', ownerAgentId: input.targetAgentId!, reason: 'handoff', expiresAt: this.leaseExpiry(),
      }));
      records.push(this.dispatchRecord(input.idempotencyKey, task.id, input.targetAgentId!, 'handoff', input.content, action.sequence, nextHop));
    } else if (input.type === 'ask') {
      records.push(this.dispatchRecord(input.idempotencyKey, task.id, input.targetAgentId!, 'ask', input.content, action.sequence, nextHop));
    } else if (input.type === 'return' && activeOwner && activeOwner !== input.actorAgentId) {
      records.push(this.dispatchRecord(
        input.idempotencyKey,
        task.id,
        activeOwner,
        'return',
        input.content,
        action.sequence,
        nextHop,
      ));
    } else if (input.type === 'complete') {
      records.push(this.record(`${input.idempotencyKey}:complete`, task.id, {
        kind: 'task-completed', byAgentId: input.actorAgentId, summary: input.content,
      }));
    }
    return records;
  }

  private recordsForArtifact(task: TaskProjection, input: ArtifactInput): LedgerRecord[] {
    this.requireAgent(input.actorAgentId);
    if (!task.participants.includes(input.actorAgentId)) {
      throw new Error('only a task participant may publish an artifact');
    }
    return [this.record(input.idempotencyKey, task.id, {
      kind: 'artifact',
      actorAgentId: input.actorAgentId,
      artifact: structuredClone(input.artifact),
      occurredAt: input.occurredAt ?? this.now().toISOString(),
      visibility: input.visibility ?? { kind: 'task-public' },
    })];
  }

  private dispatchRecord(
    baseKey: string,
    taskId: string,
    targetAgentId: string,
    reason: Dispatch['reason'],
    objective: string,
    sourceSequence: number,
    hop: number,
  ): LedgerRecord {
    this.requireAgent(targetAgentId);
    return this.record(`${baseKey}:dispatch:${targetAgentId}`, taskId, {
      kind: 'dispatch',
      dispatchId: `dispatch_${this.idFactory()}`,
      targetAgentId,
      reason,
      objective,
      sourceSequence,
      hop,
    });
  }

  private record(
    idempotencyKey: string,
    taskId: string,
    event: LedgerEvent,
    address?: MessageInput['address'],
  ): LedgerRecord {
    return {
      sequence: ++this.sequence,
      idempotencyKey,
      taskId,
      ...(address ? { address } : {}),
      recordedAt: this.now().toISOString(),
      event,
    };
  }

  private async commit(records: LedgerRecord[]): Promise<void> {
    try {
      await this.ledger.append(records);
    } catch (err) {
      this.sequence -= records.length;
      throw err;
    }
    for (const record of records) this.apply(record);
  }

  private apply(record: LedgerRecord): void {
    this.sequence = Math.max(this.sequence, record.sequence);
    this.records.push(record);
    this.idempotency.set(record.idempotencyKey, record.taskId);
    let task = this.tasks.get(record.taskId);
    if (!task) {
      if (!record.address) throw new Error(`first record for ${record.taskId} has no address`);
      task = {
        id: record.taskId,
        address: record.address,
        status: 'open',
        participants: [],
        lastSequence: record.sequence,
        lastDispatchHop: 0,
      };
      this.tasks.set(record.taskId, task);
    }
    task.lastSequence = Math.max(task.lastSequence, record.sequence);
    const event = record.event;
    if (event.kind === 'message') {
      for (const agentId of event.targetAgentIds) addParticipant(task, agentId);
      if (event.actor.type === 'agent') addParticipant(task, event.actor.id);
    } else if (event.kind === 'lease') {
      task.ownerAgentId = event.ownerAgentId;
      task.leaseExpiresAt = event.expiresAt;
      addParticipant(task, event.ownerAgentId);
    } else if (event.kind === 'action') {
      addParticipant(task, event.actorAgentId);
      if (event.targetAgentId) addParticipant(task, event.targetAgentId);
    } else if (event.kind === 'artifact') {
      addParticipant(task, event.actorAgentId);
    } else if (event.kind === 'dispatch') {
      task.lastDispatchHop = Math.max(task.lastDispatchHop, event.hop);
      addParticipant(task, event.targetAgentId);
      this.dispatches.set(event.dispatchId, {
        id: event.dispatchId,
        sequence: record.sequence,
        taskId: record.taskId,
        targetAgentId: event.targetAgentId,
        reason: event.reason,
        objective: event.objective,
        sourceSequence: event.sourceSequence,
        hop: event.hop,
        status: 'pending',
      });
    } else if (event.kind === 'ack') {
      const dispatch = this.dispatches.get(event.dispatchId);
      if (dispatch) dispatch.status = event.status;
    } else if (event.kind === 'task-completed') {
      task.status = 'completed';
    }
  }

  private validateInput(input: HubInput): void {
    if (!input.idempotencyKey.trim()) throw new Error('idempotencyKey is required');
    if (input.type !== 'artifact' && !input.content.trim() && input.type !== 'return') {
      throw new Error('content is required');
    }
    if (input.type === 'message') {
      for (const agentId of input.targetAgentIds) this.requireAgent(agentId);
      if (input.visibility?.kind === 'secret') {
        throw new Error('secret content must not be submitted to the collaboration hub');
      }
    } else if (input.type === 'artifact') {
      const artifact = input.artifact;
      if (!artifact.id.trim() || !artifact.name.trim() || !artifact.localPath.trim()) {
        throw new Error('artifact id, name, and localPath are required');
      }
      if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) throw new Error('artifact sha256 is invalid');
      if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) throw new Error('artifact size is invalid');
    }
  }

  private requireAgent(agentId: AgentId): void {
    if (!this.agents.has(agentId)) throw new Error(`unknown agent: ${agentId}`);
  }

  private leaseExpiry(): string {
    return new Date(this.now().getTime() + this.leaseMs).toISOString();
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function addParticipant(task: TaskProjection, agentId: string): void {
  if (!task.participants.includes(agentId)) task.participants.push(agentId);
}

function cloneTask(task: TaskProjection): TaskProjection {
  return { ...task, address: { ...task.address }, participants: [...task.participants] };
}

function canSee(event: LedgerEvent, agentId: string): boolean {
  if (event.kind === 'ack') return event.agentId === agentId;
  if (event.kind === 'dispatch') return event.targetAgentId === agentId;
  if (event.kind === 'lease' || event.kind === 'task-completed') return true;
  const visibility = event.kind === 'message' ? event.visibility : event.visibility;
  if (visibility.kind === 'task-public') return true;
  if (visibility.kind === 'handoff') return visibility.from === agentId || visibility.to === agentId;
  if (visibility.kind === 'targeted') return visibility.agents.includes(agentId);
  if (visibility.kind === 'private-runtime') return visibility.agent === agentId;
  return false;
}
