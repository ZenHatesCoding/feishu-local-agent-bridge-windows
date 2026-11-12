import type { AgentEvent } from './types';

export class LiveEvents {
  private queue: AgentEvent[] = [];
  private wake?: () => void;
  private ended = false;
  push(event: AgentEvent): void {
    if (this.ended) return;
    this.queue.push(event);
    if (event.type === 'done' || event.type === 'error') this.ended = true;
    this.wake?.();
  }
  async *read(): AsyncGenerator<AgentEvent> {
    while (true) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.ended) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}
