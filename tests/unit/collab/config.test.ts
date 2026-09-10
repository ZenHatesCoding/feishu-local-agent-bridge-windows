import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadHubConfig } from '../../../src/collab/config';

describe('collaboration Hub config', () => {
  it('loads schema v2 shared-token configs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-config-'));
    const path = join(dir, 'hub.json');
    await writeFile(path, JSON.stringify({
      schemaVersion: 2, listen: { host: '127.0.0.1', port: 17321 },
      ledgerPath: 'ledger.jsonl', tokenEnv: 'HUB_TOKEN', leaseMinutes: 30,
      maxCausalDepth: 8, maxConversationTurns: 32, agents: [{ id: 'world', displayName: 'World' }],
    }));
    const loaded = await loadHubConfig(path);
    expect(loaded.agents).toMatchObject([{ id: 'world' }]);
    expect(loaded.auth).toBeUndefined();
  });

  it('loads per-agent credential environment mappings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-config-auth-'));
    const path = join(dir, 'hub.json');
    await writeFile(path, JSON.stringify({
      schemaVersion: 2, listen: { host: '127.0.0.1', port: 17321 },
      ledgerPath: 'ledger.jsonl', tokenEnv: 'HUB_TOKEN',
      agents: [{ id: 'world', displayName: 'World' }],
      auth: { agentTokenEnvs: { world: 'WORLD_TOKEN' } },
    }));
    await expect(loadHubConfig(path)).resolves.toMatchObject({
      auth: { agentTokenEnvs: { world: 'WORLD_TOKEN' } },
    });
  });
});
