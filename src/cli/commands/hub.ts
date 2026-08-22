import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CollaborationClient } from '../../collab/client';
import type { ActionInput } from '../../collab/types';
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
