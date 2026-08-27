import type {
  ActionInput,
  ArtifactInput,
  AgentIdentity,
  ContextEntry,
  Dispatch,
  HubResult,
  MessageInput,
  SharedArtifact,
  TaskProjection,
} from './types';

export interface CollaborationClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class CollaborationClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CollaborationClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  submit(input: MessageInput | ActionInput | ArtifactInput): Promise<HubResult> {
    return this.request('/v1/events', { method: 'POST', body: input });
  }

  context(taskId: string, agentId: string, after = 0): Promise<{
    task: TaskProjection;
    entries: ContextEntry[];
    artifacts: SharedArtifact[];
  }> {
    return this.request(
      `/v1/tasks/${encodeURIComponent(taskId)}/context?agentId=${encodeURIComponent(agentId)}&after=${after}`,
    );
  }

  dispatches(agentId: string, after = 0): Promise<{ dispatches: Dispatch[] }> {
    return this.request(
      `/v1/dispatches/agents/${encodeURIComponent(agentId)}?after=${after}`,
    );
  }

  acknowledge(
    dispatchId: string,
    input: { agentId: string; status: 'accepted' | 'completed' | 'failed'; idempotencyKey: string },
  ): Promise<{ dispatch: Dispatch }> {
    return this.request(`/v1/dispatches/${encodeURIComponent(dispatchId)}/ack`, {
      method: 'POST',
      body: input,
    });
  }

  identities(): Promise<{ agents: AgentIdentity[] }> {
    return this.request('/v1/agents');
  }

  registerIdentity(
    agentId: string,
    openId: string,
    runtime: Pick<AgentIdentity, 'nodeId' | 'instanceId' | 'version'> = {},
  ): Promise<{ agent: AgentIdentity }> {
    return this.request(`/v1/agents/${encodeURIComponent(agentId)}/identity`, {
      method: 'POST', body: { openId, ...runtime },
    });
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const payload = await response.json() as { error?: string } & T;
    if (!response.ok) throw new Error(payload.error ?? `collaboration hub returned ${response.status}`);
    return payload;
  }
}
