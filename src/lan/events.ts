import type { LedgerRecord, Dispatch } from '../collab/types';
import type { LanRunEventRecord, LanTaskState } from './types';

/** Conversation-scoped live notification pushed over SSE after every commit. */
export interface LanConversationNotification {
  conversationId: string;
  kind: 'ledger' | 'runs' | 'task' | 'attempts';
  ledger?: LedgerRecord[];
  runs?: LanRunEventRecord[];
  task?: {
    taskId: string;
    state: LanTaskState;
    participants: string[];
    ownerAgentId?: string;
    dispatches?: Dispatch[];
  };
}

type Listener = (notification: LanConversationNotification) => void;

/**
 * In-process fan-out bus between the center's write path and open SSE
 * connections. Durable replay comes from SQLite (`events?after=`), so this
 * bus only carries live traffic and may drop when nobody listens.
 */
export class LanEventBus {
  private readonly listeners = new Map<number, { conversationId: string; listener: Listener }>();
  private nextListenerId = 1;

  subscribe(conversationId: string, listener: Listener): () => void {
    const id = this.nextListenerId++;
    this.listeners.set(id, { conversationId, listener });
    return () => {
      this.listeners.delete(id);
    };
  }

  publish(notification: LanConversationNotification): void {
    for (const entry of this.listeners.values()) {
      if (entry.conversationId !== notification.conversationId) continue;
      try {
        entry.listener(notification);
      } catch {
        // A failing SSE connection must never break the write path.
      }
    }
  }

  subscriberCount(conversationId: string): number {
    let count = 0;
    for (const entry of this.listeners.values()) {
      if (entry.conversationId === conversationId) count++;
    }
    return count;
  }
}
