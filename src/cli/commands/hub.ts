import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnProcessSync } from '../../platform/spawn';
import { CollaborationClient } from '../../collab/client';
import type { ActionInput } from '../../collab/types';
import { snapshotArtifact } from '../../collab/artifact-store';
import { startFeishuCoordinator } from '../../collab/coordinator';
import { loadHubConfig } from '../../collab/config';
import { CollaborationHub } from '../../collab/hub';
import { JsonlLedger } from '../../collab/ledger';
import { CollaborationHubServer } from '../../collab/server';

export async function runCollaborationHub(options: { config: string }): Promise<void> {
  const configPath = resolve(options.config);
  const config = await loadHubConfig(configPath);
  const token = process.env[config.tokenEnv];
  if (!token) throw new Error(`hub token environment variable is not set: ${config.tokenEnv}`);
  const hub = new CollaborationHub(new JsonlLedger(config.ledgerPath), {
    agents: config.agents,
    leaseMs: config.leaseMinutes * 60_000,
    maxHops: config.maxHops,
  });
  await hub.initialize();
  const server = new CollaborationHubServer(hub, { ...config.listen, token });
  const address = await server.listen();
  console.log(`Feishu collaboration hub listening on http://${address.host}:${address.port}`);
  console.log(`Ledger: ${config.ledgerPath}`);
  const coordinatorConfig = config.coordinator?.enabled ? config.coordinator : undefined;
  const coordinatorSecret = coordinatorConfig
    ? process.env[coordinatorConfig.appSecretEnv]
    : undefined;
  if (coordinatorConfig && !coordinatorSecret) {
    await server.close();
    throw new Error(`coordinator secret environment variable is not set: ${coordinatorConfig.appSecretEnv}`);
  }
  let coordinator: Awaited<ReturnType<typeof startFeishuCoordinator>> | undefined;
  try {
    coordinator = coordinatorConfig
      ? await startFeishuCoordinator(hub, {
          tenant: coordinatorConfig.tenant,
          appId: coordinatorConfig.appId,
          appSecret: coordinatorSecret!,
          tenantKey: coordinatorConfig.tenantKey,
          agents: config.agents,
        })
      : undefined;
  } catch (err) {
    await server.close();
    throw err;
  }

  const stop = async (): Promise<void> => {
    await Promise.all([server.close(), coordinator?.disconnect()]);
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

export async function runCollaborationAction(
  type: ActionInput['type'],
  options: {
    task: string;
    actor: string;
    target?: string;
    content: string;
    idempotencyKey?: string;
  },
): Promise<void> {
  const baseUrl = process.env.LARK_COLLAB_HUB_URL;
  const token = process.env.LARK_COLLAB_HUB_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('LARK_COLLAB_HUB_URL and LARK_COLLAB_HUB_TOKEN are required');
  }
  if ((type === 'handoff' || type === 'ask') && !options.target) {
    throw new Error(`${type} requires --target`);
  }
  const client = new CollaborationClient({ baseUrl, token });
  const result = await client.submit({
    type,
    idempotencyKey: options.idempotencyKey ?? `${type}:${randomUUID()}`,
    taskId: options.task,
    actorAgentId: options.actor,
    ...(options.target ? { targetAgentId: options.target } : {}),
    content: options.content,
  });
  console.log(JSON.stringify({ task: result.task, dispatches: result.dispatches }, null, 2));
}

export async function runArtifactPublish(options: {
  task: string;
  actor: string;
  path: string;
  chatId?: string;
  replyTo?: string;
  replyInThread?: boolean;
  name?: string;
}): Promise<void> {
  const baseUrl = requiredEnv('LARK_COLLAB_HUB_URL');
  const token = requiredEnv('LARK_COLLAB_HUB_TOKEN');
  const artifactRoot = requiredEnv('LARK_COLLAB_ARTIFACT_ROOT');
  const larkCliJs = requiredEnv('LARK_COLLAB_REAL_LARK_CLI_JS');
  if (!options.chatId && !options.replyTo) throw new Error('--chat-id or --reply-to is required');

  const sourcePath = resolve(options.path);
  const artifact = await snapshotArtifact({
    sourcePath,
    root: artifactRoot,
    taskId: options.task,
    originalName: options.name,
  });
  const sendIdempotencyKey = `collab-${options.task.slice(-12)}-${options.actor}-${artifact.sha256.slice(0, 24)}`;
  const args = options.replyTo
    ? [
        larkCliJs,
        'im',
        '+messages-reply',
        '--message-id',
        options.replyTo,
        '--file',
        artifact.name,
        '--idempotency-key',
        sendIdempotencyKey,
        ...(options.replyInThread ? ['--reply-in-thread'] : []),
        '--json',
      ]
    : [
        larkCliJs,
        'im',
        '+messages-send',
        '--chat-id',
        options.chatId!,
        '--file',
        artifact.name,
        '--idempotency-key',
        sendIdempotencyKey,
        '--json',
      ];
  const send = spawnProcessSync(process.execPath, args, {
    cwd: dirname(artifact.localPath),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (send.stdout) process.stdout.write(String(send.stdout));
  if (send.stderr) process.stderr.write(String(send.stderr));
  if (send.error) throw send.error;
  if (send.status !== 0) throw new Error(`lark-cli file send failed with exit code ${send.status}`);

  const output = parseJsonOutput(String(send.stdout ?? ''));
  const published = {
    ...artifact,
    ...optionalStringField(output, ['message_id', 'messageId'], 'sourceMessageId'),
    ...optionalStringField(output, ['file_key', 'fileKey'], 'sourceFileKey'),
  };
  const client = new CollaborationClient({ baseUrl, token });
  await client.submit({
    type: 'artifact',
    idempotencyKey: `artifact-publish:${options.task}:${options.actor}:${artifact.id}`,
    taskId: options.task,
    actorAgentId: options.actor,
    artifact: published,
  });
  process.stdout.write(`${JSON.stringify({ sharedArtifact: published }, null, 2)}\n`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseJsonOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

function optionalStringField(
  value: unknown,
  keys: string[],
  outputKey: 'sourceMessageId' | 'sourceFileKey',
): Partial<Record<'sourceMessageId' | 'sourceFileKey', string>> {
  const found = findString(value, new Set(keys));
  return found ? { [outputKey]: found } : {};
}

function findString(value: unknown, keys: ReadonlySet<string>): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === 'string' && child.trim()) return child;
  }
  for (const child of Object.values(value)) {
    const found = findString(child, keys);
    if (found) return found;
  }
  return undefined;
}
