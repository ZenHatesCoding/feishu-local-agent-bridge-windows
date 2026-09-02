import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runArtifactPublish } from '../../../src/cli/commands/hub';
import { CollaborationHub } from '../../../src/collab/hub';
import { JsonlLedger } from '../../../src/collab/ledger';
import { CollaborationHubServer } from '../../../src/collab/server';

const servers: CollaborationHubServer[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('collaboration artifact publisher', () => {
  it('sends through the current lark-cli identity and registers the durable snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-publish-'));
    const agentId = `world-${'x'.repeat(80)}`;
    const source = join(root, 'report.pptx');
    const fakeCli = join(root, 'fake-lark-cli.mjs');
    await writeFile(source, 'deck bytes');
    await writeFile(fakeCli, `
      const args = process.argv.slice(2);
      if (!args.includes('--file') || !args.includes('report.pptx')) process.exit(7);
      const keyIndex = args.indexOf('--idempotency-key');
      const key = keyIndex >= 0 ? args[keyIndex + 1] : '';
      if (!key || key.length > 50 || !/^collab-[a-zA-Z0-9-]+$/.test(key)) process.exit(8);
      console.log(JSON.stringify({ data: { message_id: 'om_sent', file_key: 'file_sent' } }));
    `);

    const hub = new CollaborationHub(new JsonlLedger(join(root, 'ledger.jsonl')), {
      agents: [{ id: agentId, displayName: 'World' }, { id: 'chariot', displayName: 'Chariot' }],
    });
    await hub.initialize();
    const assigned = await hub.submit({
      type: 'message',
      idempotencyKey: 'assign',
      address: { tenantKey: 'tenant', chatId: 'chat', threadId: 'topic' },
      messageId: 'om_user',
      actor: { type: 'human', id: 'user' },
      content: 'Create a deck',
      targetAgentIds: [agentId],
    });
    const server = new CollaborationHubServer(hub, { host: '127.0.0.1', port: 0, token: 'test' });
    servers.push(server);
    const address = await server.listen();
    process.env.LARK_COLLAB_HUB_URL = `http://127.0.0.1:${address.port}`;
    process.env.LARK_COLLAB_HUB_TOKEN = 'test';
    process.env.LARK_COLLAB_ARTIFACT_ROOT = join(root, 'artifacts');
    process.env.LARK_COLLAB_REAL_LARK_CLI_JS = fakeCli;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runArtifactPublish({
      task: assigned.task.id,
      actor: agentId,
      path: source,
      replyTo: 'om_user',
      replyInThread: true,
    });

    expect(hub.getArtifacts(assigned.task.id, agentId)).toMatchObject([{
      name: 'report.pptx',
      sourceMessageId: 'om_sent',
      sourceFileKey: 'file_sent',
      kind: 'presentation',
    }]);
  });

  it('repairs a missing private lark-channel bot binding and retries delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-publish-repair-'));
    const source = join(root, 'assessment.md');
    const marker = join(root, 'bound');
    const fakeCli = join(root, 'fake-lark-cli.mjs');
    await writeFile(source, 'assessment');
    await writeFile(fakeCli, `
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      const marker = process.env.TEST_BIND_MARKER;
      if (args[0] === 'config' && args[1] === 'bind') {
        if (!args.includes('--source') || !args.includes('lark-channel') ||
            !args.includes('--identity') || !args.includes('bot-only')) process.exit(9);
        fs.writeFileSync(marker, 'bound');
        process.exit(0);
      }
      if (args.includes('--file') && !fs.existsSync(marker)) {
        console.error(JSON.stringify({ error: { message: 'lark-channel context detected but lark-cli is not bound to it' } }));
        process.exit(3);
      }
      console.log(JSON.stringify({ data: { message_id: 'om_retried', file_key: 'file_retried' } }));
    `);

    const hub = new CollaborationHub(new JsonlLedger(join(root, 'ledger.jsonl')), {
      agents: [{ id: 'chariot', displayName: 'Chariot' }],
    });
    await hub.initialize();
    const assigned = await hub.submit({
      type: 'message', idempotencyKey: 'assign-repair',
      address: { tenantKey: 'tenant', chatId: 'chat', threadId: 'topic' },
      messageId: 'om_user', actor: { type: 'human', id: 'user' },
      content: 'Write an assessment', targetAgentIds: ['chariot'],
    });
    const server = new CollaborationHubServer(hub, { host: '127.0.0.1', port: 0, token: 'test' });
    servers.push(server);
    const address = await server.listen();
    process.env.LARK_COLLAB_HUB_URL = `http://127.0.0.1:${address.port}`;
    process.env.LARK_COLLAB_HUB_TOKEN = 'test';
    process.env.LARK_COLLAB_ARTIFACT_ROOT = join(root, 'artifacts');
    process.env.LARK_COLLAB_REAL_LARK_CLI_JS = fakeCli;
    process.env.TEST_BIND_MARKER = marker;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runArtifactPublish({
      task: assigned.task.id, actor: 'chariot', path: source,
      replyTo: 'om_user', replyInThread: true,
    });

    await expect(access(marker)).resolves.toBeUndefined();
    expect(hub.getArtifacts(assigned.task.id, 'chariot')).toMatchObject([{
      name: 'assessment.md', sourceMessageId: 'om_retried', sourceFileKey: 'file_retried',
    }]);
  });
});
