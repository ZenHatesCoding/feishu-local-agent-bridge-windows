export type MemoryKind = 'goal' | 'constraint' | 'decision' | 'progress' | 'todo' | 'evidence' | 'hypothesis';
export type MemoryStatus = 'active' | 'resolved' | 'superseded' | 'disputed' | 'parked';
export interface MemoryItem {
  itemId: string;
  kind: MemoryKind;
  text: string;
  status: MemoryStatus;
  sourceRefs: string[];
  evidenceLevel: 'human-explicit' | 'agent-reported' | 'tool-observed';
  pinned?: boolean;
  supersedes?: string;
}
export interface MemoryEvent {
  id: string; seq: number; origin: string; kind: string; content: string;
  actor: 'human' | 'agent' | 'tool' | 'unknown'; at: string; data?: unknown;
}
export interface MemoryTopic {
  id: string; scope: string; next_seq: number; revision: number; state_through: number;
  items: MemoryItem[];
}
export interface MemoryCandidate {
  baseRevision: number;
  through: number;
  items: MemoryItem[];
  summary?: string;
}
export interface MemoryBinding {
  topic: string; runId: string; fence: number; nonce: string; expires: number;
}
export interface MemoryJob {
  id: string; topic: string; kind: 'update' | 'condense'; baseRevision: number;
  start: number; end: number; sources: string[]; input: string; token: string;
}
export interface MemoryLimits {
  total: number; state: number; summaries: number; recent: number; retrieval: number;
  chunk: number; timeoutMs: number; maxCalls: number;
}
export const DEFAULT_MEMORY_LIMITS: MemoryLimits = {
  total: 12000, state: 3000, summaries: 4000, recent: 3000, retrieval: 2000,
  chunk: 16000, timeoutMs: 120000, maxCalls: 8,
};
/** A conservative UTF-8 byte upper bound, including serialized wrappers (not chars/4). */
export function memoryCost(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}
export function memoryError(code: string): never { throw new Error(`memory:${code}`); }
export function memoryLimitsFromEnvironment(): Partial<MemoryLimits> {
  const raw = process.env.LARK_MEMORY_MAX_TOKENS;
  if (!raw) return {};
  const total = Number(raw);
  if (!Number.isSafeInteger(total) || total < 4000 || total > 128000) memoryError('invalid-total-budget');
  return { total, state: Math.floor(total / 4), summaries: Math.floor(total / 3), recent: Math.floor(total / 4), retrieval: Math.floor(total / 6) };
}
