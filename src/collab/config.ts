import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AgentRegistration } from './types';

export interface HubConfig {
  schemaVersion: 1;
  listen: { host: string; port: number };
  ledgerPath: string;
  tokenEnv: string;
  leaseMinutes: number;
  maxCausalDepth: number;
  agents: AgentRegistration[];
  coordinator?: {
    enabled: boolean;
    tenant: 'feishu' | 'lark';
    appId: string;
    appSecretEnv: string;
    tenantKey: string;
  };
}

export async function loadHubConfig(path: string): Promise<HubConfig> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<HubConfig>;
  if (parsed.schemaVersion !== 1) throw new Error('hub config schemaVersion must be 1');
  if (!parsed.listen || !parsed.ledgerPath || !parsed.tokenEnv || !parsed.agents?.length) {
    throw new Error('hub config requires listen, ledgerPath, tokenEnv, and agents');
  }
  const ids = new Set<string>();
  for (const agent of parsed.agents) {
    if (!agent.id?.trim() || !agent.displayName?.trim()) throw new Error('each agent requires id and displayName');
    if (ids.has(agent.id)) throw new Error(`duplicate agent id: ${agent.id}`);
    ids.add(agent.id);
  }
  if (parsed.coordinator?.enabled) {
    const coordinator = parsed.coordinator;
    if (!coordinator.appId || !coordinator.appSecretEnv || !coordinator.tenantKey) {
      throw new Error('enabled coordinator requires appId, appSecretEnv, and tenantKey');
    }
    if (coordinator.tenant !== 'feishu' && coordinator.tenant !== 'lark') {
      throw new Error('coordinator tenant must be feishu or lark');
    }
  }
  const base = dirname(resolve(path));
  return {
    schemaVersion: 1,
    listen: {
      host: parsed.listen.host ?? '127.0.0.1',
      port: parsed.listen.port ?? 17321,
    },
    ledgerPath: resolve(base, parsed.ledgerPath),
    tokenEnv: parsed.tokenEnv,
    leaseMinutes: parsed.leaseMinutes ?? 30,
    maxCausalDepth: parsed.maxCausalDepth ?? (parsed as Partial<HubConfig> & { maxHops?: number }).maxHops ?? 8,
    agents: parsed.agents,
    ...(parsed.coordinator ? { coordinator: parsed.coordinator } : {}),
  };
}
