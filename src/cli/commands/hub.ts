import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnProcessSync } from '../../platform/spawn';
import { CollaborationClient } from '../../collab/client';
import type { ActionInput, SharedArtifact } from '../../collab/types';
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
    maxCausalDepth: config.maxCausalDepth,
  });
  await hub.initialize();
  const agentTokens = Object.fromEntries(
    Object.entries(config.auth?.agentTokenEnvs ?? {}).map(([agentId, envName]) => {
      const agentToken = process.env[envName];
      if (!agentToken) throw new Error(`agent token environment variable is not set: ${envName}`);
      return [agentId, agentToken];
    }),
  );
  const uniqueTokens = new Set([token, ...Object.values(agentTokens)]);
  if (uniqueTokens.size !== 1 + Object.keys(agentTokens).length) {
    throw new Error('Hub admin and Agent credentials must all be unique');
  }
  const server = new CollaborationHubServer(hub, { ...config.listen, token, agentTokens });
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
    causedByDispatchId?: string;
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
  const causedByDispatchId = options.causedByDispatchId ?? process.env.LARK_COLLAB_DISPATCH_ID;
  if (!causedByDispatchId) throw new Error('collaboration actions require --caused-by-dispatch or LARK_COLLAB_DISPATCH_ID');
  const result = await client.submit({
    type,
    idempotencyKey: options.idempotencyKey ?? `${type}:${randomUUID()}`,
    taskId: options.task,
    actorAgentId: options.actor,
    causedByDispatchId,
    ...(options.target ? { targetAgentId: options.target } : {}),
    content: options.content,
  });
  console.log(JSON.stringify({ task: result.task, dispatches: result.dispatches }, null, 2));
}

/** Authorize a delegation and visibly wake the target bot in the current topic. */
export async function runCollaborationDelegate(
  type: 'handoff' | 'ask',
  options: { target: string; content: string; task?: string; actor?: string; replyTo?: string; causedByDispatch?: string },
): Promise<void> {
  const baseUrl = requiredEnv('LARK_COLLAB_HUB_URL');
  const token = requiredEnv('LARK_COLLAB_HUB_TOKEN');
  const taskId = options.task ?? requiredEnv('LARK_COLLAB_TASK_ID');
  const actor = options.actor ?? requiredEnv('LARK_COLLAB_AGENT_ID');
  const replyTo = options.replyTo ?? requiredEnv('LARK_COLLAB_REPLY_TO');
  const causedByDispatchId = options.causedByDispatch ?? requiredEnv('LARK_COLLAB_DISPATCH_ID');
  const client = new CollaborationClient({ baseUrl, token });
  const target = options.target.trim();
  const content = options.content.trim();
  if (!target || !content) throw new Error('target and content are required');
  const identity = (await client.identities()).agents.find((agent) => agent.id === target);
  if (!identity) {
    throw new Error(`target agent is connected but has not registered its Feishu identity: ${target}`);
  }
  const digest = createHash('sha256').update(`${type}\0${taskId}\0${causedByDispatchId}\0${actor}\0${target}\0${content}`).digest('hex').slice(0, 24);
  const result = await client.submit({
    type,
    idempotencyKey: `delegate:${digest}`,
    taskId,
    actorAgentId: actor,
    causedByDispatchId,
    targetAgentId: target,
    content,
  });
  const post = JSON.stringify({
    zh_cn: { content: [[
      { tag: 'at', user_id: identity.openId, user_name: identity.displayName },
      { tag: 'text', text: ` ${content}` },
    ]] },
  });
  const send = spawnProcessSync('lark-cli', [
    'im', '+messages-reply', '--message-id', replyTo, '--content', post,
    '--msg-type', 'post', '--reply-in-thread', '--idempotency-key', `delegate-${digest}`, '--json',
  ], { env: process.env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (send.stdout) process.stdout.write(String(send.stdout));
  if (send.stderr) process.stderr.write(String(send.stderr));
  if (send.error) throw send.error;
  if (send.status !== 0) throw new Error(`Feishu delegation mention failed with exit code ${send.status}`);
  process.stdout.write(`${JSON.stringify({ task: result.task, dispatches: result.dispatches, mentioned: target }, null, 2)}\n`);
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
  const sendIdempotencyKey = `collab-${options.task.slice(-8)}-${options.actor}-${artifact.sha256.slice(0, 16)}`.slice(0, 50);
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
  let send = runLarkCli(larkCliJs, args, dirname(artifact.localPath));
  if (send.status !== 0 && isUnboundLarkChannel(send)) {
    const repair = runLarkCli(larkCliJs, [
      'config', 'bind', '--source', 'lark-channel', '--identity', 'bot-only',
    ]);
    if (repair.error) throw repair.error;
    if (repair.status !== 0) {
      emitProcessOutput(repair);
      throw new Error(`lark-cli bot-only binding repair failed with exit code ${repair.status}`);
    }
    send = runLarkCli(larkCliJs, args, dirname(artifact.localPath));
  }
  emitProcessOutput(send);
  if (send.error) throw send.error;
  if (send.status !== 0) throw new Error(`lark-cli file send failed with exit code ${send.status}`);

  const output = parseJsonOutput(String(send.stdout ?? ''));
  const published = {
    ...artifact,
    ...optionalStringField(output, ['message_id', 'messageId'], 'sourceMessageId'),
    ...optionalStringField(output, ['file_key', 'fileKey'], 'sourceFileKey'),
  };
  if (published.sourceMessageId && published.sourceFileKey) {
    published.locator = {
      provider: 'feishu',
      messageId: published.sourceMessageId,
      fileKey: published.sourceFileKey,
    };
  }
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

function runLarkCli(larkCliJs: string, args: string[], cwd?: string) {
  return spawnProcessSync(process.execPath, [larkCliJs, ...args], {
    ...(cwd ? { cwd } : {}),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

function isUnboundLarkChannel(result: ReturnType<typeof runLarkCli>): boolean {
  const output = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`;
  return /lark-channel context detected but lark-cli is not bound to it/i.test(output);
}

function emitProcessOutput(result: ReturnType<typeof runLarkCli>): void {
  if (result.stdout) process.stdout.write(String(result.stdout));
  if (result.stderr) process.stderr.write(String(result.stderr));
}

export async function runArtifactRegisterGit(options: {
  task: string;
  actor: string;
  path: string;
  repository: string;
  commit: string;
  repoPath?: string;
  name?: string;
}): Promise<void> {
  const client = new CollaborationClient({
    baseUrl: requiredEnv('LARK_COLLAB_HUB_URL'),
    token: requiredEnv('LARK_COLLAB_HUB_TOKEN'),
  });
  const artifact = await snapshotArtifact({
    sourcePath: resolve(options.path),
    root: requiredEnv('LARK_COLLAB_ARTIFACT_ROOT'),
    taskId: options.task,
    originalName: options.name,
  });
  artifact.locator = {
    provider: 'git',
    repository: options.repository,
    commit: options.commit,
    ...(options.repoPath ? { path: options.repoPath } : {}),
  };
  await client.submit({
    type: 'artifact',
    idempotencyKey: `artifact-git:${options.task}:${options.actor}:${artifact.id}:${options.commit}`,
    taskId: options.task,
    actorAgentId: options.actor,
    artifact,
  });
  process.stdout.write(`${JSON.stringify({ sharedArtifact: artifact }, null, 2)}\n`);
}

export async function runArtifactResolve(options: {
  task: string;
  actor: string;
  id?: string;
  name?: string;
  list?: boolean;
}): Promise<void> {
  const client = new CollaborationClient({
    baseUrl: requiredEnv('LARK_COLLAB_HUB_URL'),
    token: requiredEnv('LARK_COLLAB_HUB_TOKEN'),
  });
  const context = await client.context(options.task, options.actor);
  if (options.list) {
    process.stdout.write(`${JSON.stringify({ artifacts: context.artifacts.map(artifactCatalogItem) }, null, 2)}\n`);
    return;
  }
  const id = options.id?.trim().toLocaleLowerCase();
  const name = options.name?.trim().toLocaleLowerCase();
  if (!id && !name) throw new Error('artifact resolve requires --id, --name, or --list');
  const matches = context.artifacts.filter((artifact) =>
    (id && artifact.id.toLocaleLowerCase() === id) ||
    (name && artifact.name.toLocaleLowerCase() === name),
  );
  if (matches.length === 0) throw new Error('artifact not found in the current task visibility');
  if (matches.length > 1) throw new Error('artifact selector is ambiguous; use --id');
  process.stdout.write(`${JSON.stringify({ artifact: matches[0] }, null, 2)}\n`);
}

function artifactCatalogItem(artifact: SharedArtifact): Record<string, unknown> {
  return {
    id: artifact.id,
    name: artifact.name,
    kind: artifact.kind,
    size: artifact.size,
    ...(artifact.mime ? { mime: artifact.mime } : {}),
  };
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
