import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LanCenter } from './center';
import { LanWorker } from './worker';
import type { LanFakeAgentStep, LanWorkerConfig } from './types';

export interface LanSimNodeSpec {
  agentId: string;
  displayName: string;
  /** Fake-agent steps; defaults to a deterministic echo answer. */
  script?: LanFakeAgentStep[];
}

export interface LanSimTopologyOptions {
  /** Root directory for this simulated deployment (created if missing). */
  dataDir: string;
  nodes: LanSimNodeSpec[];
  /** Fixed port for the center; 0/undefined picks a free port. */
  port?: number;
  heartbeatTimeoutMs?: number;
}

/**
 * Single-machine simulation topology: one LAN center plus N fake-agent
 * workers, each an independent in-process node with its own credentials.
 * This is the L0 harness — the same code paths a real deployment uses,
 * differing only in manifest values (loopback address, fake runtime).
 */
export class LanSimTopology {
  readonly center: LanCenter;
  readonly workers = new Map<string, LanWorker>();
  readonly nodeSpecs = new Map<string, LanSimNodeSpec>();
  readonly url: string;
  readonly ownerUsername = 'owner';
  readonly ownerPassword: string;
  private ownerTokenValue?: string;

  private constructor(
    options: LanSimTopologyOptions,
    center: LanCenter,
    readonly port: number,
    password: string,
  ) {
    this.center = center;
    this.ownerPassword = password;
    this.url = `http://127.0.0.1:${port}`;
    for (const node of options.nodes) {
      this.nodeSpecs.set(node.agentId, node);
      const workerConfig: LanWorkerConfig = {
        centerUrl: this.url,
        agent: { id: node.agentId, displayName: node.displayName },
        token: center.agentToken(node.agentId),
        runtime: { kind: 'fake', ...(node.script ? { script: node.script } : {}) },
        nodeId: `node-${node.agentId}`,
        instanceId: `inst-${node.agentId}-${randomUUID().slice(0, 6)}`,
        pollIntervalMs: 200,
        heartbeatIntervalMs: 500,
      };
      this.workers.set(node.agentId, new LanWorker(workerConfig));
    }
  }

  static async start(options: LanSimTopologyOptions): Promise<LanSimTopology> {
    await mkdir(options.dataDir, { recursive: true });
    const password = `pw-${randomUUID().slice(0, 10)}`;
    const center = new LanCenter({
      deploymentId: 'lan-sim',
      dataDir: options.dataDir,
      listen: { host: '127.0.0.1', port: options.port ?? 0 },
      users: [{ username: 'owner', password }],
      agents: options.nodes.map((node) => ({ id: node.agentId, displayName: node.displayName })),
      ...(options.heartbeatTimeoutMs ? { heartbeatTimeoutMs: options.heartbeatTimeoutMs } : {}),
    });
    await center.initialize();
    const address = await center.listen();
    const topology = new LanSimTopology(options, center, address.port, password);
    for (const worker of topology.workers.values()) {
      await worker.start();
    }
    return topology;
  }

  async stop(): Promise<void> {
    for (const worker of this.workers.values()) {
      await worker.stop();
    }
    await this.center.close();
  }

  /**
   * Pause one worker node (no active run expected). Used by tests that need
   * to drive an agent's API surface by hand without racing the poll loop.
   */
  async pauseWorker(agentId: string): Promise<void> {
    const worker = this.workers.get(agentId);
    if (!worker) throw new Error(`unknown sim worker: ${agentId}`);
    await worker.stop();
  }

  /** Resume a paused worker as a fresh instance (new instanceId). */
  async resumeWorker(agentId: string, script?: LanFakeAgentStep[]): Promise<void> {
    const spec = this.nodeSpecs.get(agentId);
    if (!spec) throw new Error(`unknown sim worker: ${agentId}`);
    const worker = new LanWorker({
      centerUrl: this.url,
      agent: { id: spec.agentId, displayName: spec.displayName },
      token: this.center.agentToken(spec.agentId),
      runtime: { kind: 'fake', ...(script ? { script } : spec.script ? { script: spec.script } : {}) },
      nodeId: `node-${spec.agentId}`,
      instanceId: `inst-${spec.agentId}-${randomUUID().slice(0, 6)}`,
      pollIntervalMs: 200,
      heartbeatIntervalMs: 500,
    });
    this.workers.set(agentId, worker);
    await worker.start();
  }

  async ownerToken(): Promise<string> {
    if (this.ownerTokenValue) return this.ownerTokenValue;
    const response = await fetch(`${this.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.ownerUsername, password: this.ownerPassword }),
    });
    if (!response.ok) throw new Error(`sim login failed: HTTP ${response.status}`);
    const parsed = await response.json() as { token: string };
    this.ownerTokenValue = parsed.token;
    return parsed.token;
  }

  async api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const token = await this.ownerToken();
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${String(parsed.error ?? response.statusText)}`);
    return parsed;
  }
}
