import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LanSimTopology, type LanSimNodeSpec } from '../../../src/lan/sim';

let dataDir: string;
let topology: LanSimTopology;
const webDir = resolve('web/dist');

const nodes: LanSimNodeSpec[] = [{ agentId: 'alpha', displayName: 'Alpha' }];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'lan-web-'));
  topology = await LanSimTopology.start({ dataDir, nodes, webDir });
});

afterAll(async () => {
  await topology.stop();
  await rm(dataDir, { recursive: true, force: true });
});

describe('workbench static serving', () => {
  it('serves the built SPA index at /', async () => {
    const response = await fetch(`${topology.url}/`);
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('LAN Collaboration Workbench');
  });

  it('serves hashed asset bundles', async () => {
    const index = await (await fetch(`${topology.url}/`)).text();
    const assetMatch = index.match(/src="(\/assets\/[^"]+\.js)"/);
    expect(assetMatch).not.toBeNull();
    const asset = await fetch(`${topology.url}${assetMatch![1]}`);
    expect(asset.ok).toBe(true);
    expect(asset.headers.get('content-type')).toContain('javascript');
  });

  it('falls back to the SPA shell for client-side routes', async () => {
    const response = await fetch(`${topology.url}/some/client/route`);
    expect(response.ok).toBe(true);
    expect(await response.text()).toContain('LAN Collaboration Workbench');
  });

  it('rejects path traversal outside the web root', async () => {
    // Encoded separators survive URL path parsing and must be resolved away.
    const slash = await fetch(`${topology.url}/..%2f..%2fpackage.json`);
    expect(slash.ok).toBe(false);
    const backslash = await fetch(`${topology.url}/..%5c..%5cpackage.json`);
    expect(backslash.ok).toBe(false);
    // Dot-dot path segments are normalized by URL parsing itself and land on
    // the SPA fallback, never on the file system.
    const normalized = await fetch(`${topology.url}/%2e%2e/%2e%2e/package.json`);
    expect(normalized.ok).toBe(true);
    expect(normalized.headers.get('content-type')).toContain('text/html');
  });

  it('keeps the API surface authenticated next to the public shell', async () => {
    const anonymous = await fetch(`${topology.url}/api/conversations`);
    expect(anonymous.status).toBe(401);
    const login = await topology.api('GET', '/api/conversations');
    expect(login).toBeDefined();
  });
});
