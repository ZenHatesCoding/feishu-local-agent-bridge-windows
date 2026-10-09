import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { LanCenter } from '../../lan/center';
import { LanSimTopology, type LanSimNodeSpec } from '../../lan/sim';
import { LanWorker, loadWorkerConfig } from '../../lan/worker';
import type { LanCenterConfig } from '../../lan/types';

function resolveFrom(configPath: string, target: string | undefined): string | undefined {
  if (!target) return undefined;
  return isAbsolute(target) ? target : resolve(dirname(configPath), target);
}

async function readJson(configPath: string): Promise<Record<string, unknown>> {
  const text = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') throw new Error(`invalid JSON config: ${configPath}`);
  return parsed;
}

async function loadCenterConfig(configPath: string): Promise<LanCenterConfig> {
  const parsed = await readJson(configPath);
  const listen = (parsed.listen ?? {}) as { host?: string; port?: number };
  const config: LanCenterConfig = {
    deploymentId: String(parsed.deploymentId ?? 'lan-center'),
    dataDir: resolveFrom(configPath, String(parsed.dataDir ?? 'data'))!,
    listen: { host: listen.host ?? '0.0.0.0', port: listen.port ?? 8787 },
    users: (parsed.users ?? []) as LanCenterConfig['users'],
    agents: (parsed.agents ?? []) as LanCenterConfig['agents'],
    ...(parsed.heartbeatTimeoutMs ? { heartbeatTimeoutMs: Number(parsed.heartbeatTimeoutMs) } : {}),
  };
  const webDir = resolveFrom(configPath, parsed.webDir ? String(parsed.webDir) : undefined);
  if (webDir) config.webDir = webDir;
  if (config.users.length === 0) throw new Error('lan center config needs at least one user');
  if (config.agents.length === 0) throw new Error('lan center config needs at least one agent');
  return config;
}

function waitForSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve(signal);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

/** `lan center -c <config>`: run the LAN collaboration center in the foreground. */
export async function runLanCenter(opts: { config: string }): Promise<void> {
  const config = await loadCenterConfig(opts.config);
  const center = new LanCenter(config);
  await center.initialize();
  const address = await center.listen();
  const users = config.users.map((user) => user.username).join(', ');
  console.log(`[lan-center] listening on http://${address.host}:${address.port}`);
  console.log(`[lan-center] deployment=${config.deploymentId} agents=${config.agents.length} users=${users}`);
  if (config.webDir) console.log(`[lan-center] workbench served from ${config.webDir}`);
  console.log(`[lan-center] agent credentials: ${join(config.dataDir, 'credentials', '<agentId>.token')}`);
  const signal = await waitForSignal();
  console.log(`[lan-center] ${signal} received, shutting down...`);
  await center.close();
}

/** `lan worker -c <config>`: run one LAN worker node in the foreground. */
export async function runLanWorker(opts: { config: string }): Promise<void> {
  const config = await loadWorkerConfig(opts.config);
  const worker = new LanWorker(config);
  await worker.start();
  console.log(
    `[lan-worker] ${config.agent.id} (${config.runtime.kind} runtime) polling ${config.centerUrl}`,
  );
  const signal = await waitForSignal();
  console.log(`[lan-worker] ${signal} received, stopping ${config.agent.id}...`);
  await worker.stop();
}

/** `lan sim -c <config>`: one-command L0 topology (center + fake workers, loopback only). */
export async function runLanSim(opts: { config: string }): Promise<void> {
  const parsed = await readJson(opts.config);
  const nodes = (parsed.nodes ?? []) as LanSimNodeSpec[];
  if (nodes.length === 0) throw new Error('lan sim config needs a nodes[] array');
  const port = parsed.port ? Number(parsed.port) : undefined;
  const defaultDataDir = resolve(dirname(opts.config), 'lan-sim-data');
  const topology = await LanSimTopology.start({
    dataDir: resolveFrom(opts.config, String(parsed.dataDir ?? defaultDataDir))!,
    nodes,
    ...(port ? { port } : {}),
    ...(parsed.heartbeatTimeoutMs ? { heartbeatTimeoutMs: Number(parsed.heartbeatTimeoutMs) } : {}),
    ...(parsed.webDir ? { webDir: resolveFrom(opts.config, String(parsed.webDir))! } : {}),
  });
  console.log('[lan-sim] L0 topology running (single-machine simulation, not a real LAN)');
  console.log(`[lan-sim] workbench: ${topology.url}`);
  console.log(`[lan-sim] owner login: ${topology.ownerUsername} / ${topology.ownerPassword}`);
  console.log(`[lan-sim] agents: ${nodes.map((node) => node.agentId).join(', ')}`);
  console.log('[lan-sim] press Ctrl-C to stop');
  const signal = await waitForSignal();
  console.log(`[lan-sim] ${signal} received, stopping...`);
  await topology.stop();
}
