import type { LanApiClient, LanRunEventRecord, LedgerRecord } from './api';

export interface StreamHandlers {
  onLedgerRecord?: (record: LedgerRecord) => void;
  onRunRecord?: (record: LanRunEventRecord) => void;
  onTask?: (task: { id: string; status: string; participants: string[]; ownerAgentId?: string }) => void;
  onStatusChange?: (status: StreamStatus) => void;
}

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'stopped';

/**
 * SSE subscription with automatic reconnect and dual-cursor catch-up.
 * The server replays everything after the cursors on (re)connect, and
 * ConversationState deduplicates by ids, so reconnects are seamless.
 */
export class ConversationStream {
  private source: EventSource | undefined;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;

  constructor(
    private readonly client: LanApiClient,
    private readonly conversationId: string,
    private readonly cursors: () => { ledger: number; runs: number },
    private readonly handlers: StreamHandlers = {},
  ) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  private setStatus(status: StreamStatus): void {
    this.handlers.onStatusChange?.(status);
  }

  private open(): void {
    if (this.stopped) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const { ledger, runs } = this.cursors();
    const source = new EventSource(this.client.streamUrl(this.conversationId, ledger, runs));
    this.source = source;

    source.addEventListener('open', () => {
      this.attempt = 0;
      this.setStatus('live');
    });
    source.addEventListener('ledger', (event) => {
      this.handlers.onLedgerRecord?.(JSON.parse((event as MessageEvent<string>).data) as LedgerRecord);
    });
    source.addEventListener('runs', (event) => {
      this.handlers.onRunRecord?.(JSON.parse((event as MessageEvent<string>).data) as LanRunEventRecord);
    });
    source.addEventListener('task', (event) => {
      this.handlers.onTask?.(JSON.parse((event as MessageEvent<string>).data) as { id: string; status: string; participants: string[]; ownerAgentId?: string });
    });
    source.addEventListener('error', () => {
      source.close();
      if (this.stopped) return;
      this.attempt += 1;
      const delay = Math.min(5000, 300 * this.attempt);
      this.setStatus('reconnecting');
      this.reconnectTimer = setTimeout(() => this.open(), delay);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.source?.close();
    this.setStatus('stopped');
  }
}
