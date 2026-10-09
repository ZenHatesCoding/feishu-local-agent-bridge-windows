/** Client types mirroring the LAN center API payloads. */

export interface LanAgentInfo {
  id: string;
  displayName: string;
  online: boolean;
  nodeId?: string;
  lastSeenAt?: string;
}

export interface LanConversationInfo {
  id: string;
  title: string;
  createdAt: string;
  createdBy: string;
  state: string;
  lastActivityAt?: string;
}

export interface LanTaskInfo {
  id: string;
  status: string;
  participants: string[];
  ownerAgentId?: string;
}

export interface LanDispatchInfo {
  id: string;
  sequence: number;
  taskId: string;
  targetAgentId: string;
  reason: 'mention' | 'handoff' | 'ask' | 'return';
  objective: string;
  status: string;
}

export interface LanStoredFileInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  uploadedBy: string;
  createdAt: string;
}

export interface LedgerRecord {
  sequence: number;
  taskId: string;
  event: {
    kind: 'message' | 'message-routing' | 'lease' | 'dispatch' | 'ack' | 'action' | 'artifact' | 'task-completed';
    [key: string]: unknown;
  };
}

/** Shape of the SSE 'task' frame pushed by the center. */
export interface TaskFrame {
  taskId: string;
  state: string;
  participants: string[];
  ownerAgentId?: string;
  dispatches?: LanDispatchInfo[];
}

export type LanRunEventType =
  | 'RUN_STARTED'
  | 'RUN_STATUS'
  | 'TEXT_MESSAGE_CONTENT'
  | 'TOOL_CALL_STARTED'
  | 'TOOL_CALL_RESULT'
  | 'RUN_FINISHED'
  | 'RUN_ERROR';

export interface LanRunEventRecord {
  streamId: number;
  conversationId: string;
  taskId: string;
  runId: string;
  agentId?: string;
  type: LanRunEventType;
  createdAt: string;
  [key: string]: unknown;
}

export interface LanCatchUp {
  ledger: LedgerRecord[];
  runs: LanRunEventRecord[];
  cursor: { ledger: number; runs: number };
}

export class LanApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Thin fetch wrapper: bearer token, JSON bodies, meaningful errors. */
export class LanApiClient {
  constructor(
    private readonly base: string,
    private token?: string,
  ) {}

  setToken(token: string | undefined): void {
    this.token = token;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      throw new LanApiError(response.status, String(parsed.error ?? response.statusText));
    }
    return parsed as T;
  }

  login(username: string, password: string): Promise<{ token: string; user: { username: string; displayName: string } }> {
    return this.request('POST', '/api/session', { username, password });
  }

  logout(): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/session/logout');
  }

  conversationFiles(conversationId: string): Promise<{ files: LanStoredFileInfo[] }> {
    return this.request('GET', `/api/conversations/${encodeURIComponent(conversationId)}/files`);
  }

  me(): Promise<{ user: { username: string; displayName: string } }> {
    return this.request('GET', '/api/me');
  }

  agents(): Promise<{ agents: LanAgentInfo[] }> {
    return this.request('GET', '/api/agents');
  }

  conversations(): Promise<{ conversations: LanConversationInfo[] }> {
    return this.request('GET', '/api/conversations');
  }

  createConversation(title: string): Promise<{ conversation: LanConversationInfo }> {
    return this.request('POST', '/api/conversations', { title });
  }

  catchUp(conversationId: string, ledgerAfter: number, runAfter: number): Promise<LanCatchUp> {
    return this.request(
      'GET',
      `/api/conversations/${encodeURIComponent(conversationId)}/events?ledgerAfter=${ledgerAfter}&runAfter=${runAfter}`,
    );
  }

  sendMessage(
    conversationId: string,
    input: { content: string; targetAgentIds: string[]; idempotencyKey?: string },
  ): Promise<{ task: LanTaskInfo; dispatches: LanDispatchInfo[]; duplicate: boolean }> {
    return this.request(
      'POST',
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      input,
    );
  }

  cancel(conversationId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/api/conversations/${encodeURIComponent(conversationId)}/cancel`);
  }

  uploadFile(conversationId: string, file: File): Promise<{ file: LanStoredFileInfo }> {
    const base = this.base;
    const token = this.token;
    return (async () => {
      const response = await fetch(`${base}/api/files`, {
        method: 'POST',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'content-type': file.type || 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name),
          'x-conversation-id': conversationId,
        },
        body: file,
      });
      const text = await response.text();
      const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (!response.ok) throw new LanApiError(response.status, String(parsed.error ?? response.statusText));
      return parsed as { file: LanStoredFileInfo };
    })();
  }

  fileUrl(fileId: string): string {
    return `${this.base}/api/files/${encodeURIComponent(fileId)}`;
  }

  streamUrl(conversationId: string, ledgerAfter: number, runAfter: number): string {
    const token = encodeURIComponent(this.token ?? '');
    return `${this.base}/api/conversations/${encodeURIComponent(conversationId)}/stream?token=${token}&ledgerAfter=${ledgerAfter}&runAfter=${runAfter}`;
  }
}
