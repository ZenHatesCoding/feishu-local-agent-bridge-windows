import type { AgentRegistration } from './types';

export interface StructuredMention {
  openId?: string;
  name?: string;
}

export function resolveMentionedAgents(
  msg: { mentions?: readonly StructuredMention[] },
  agents: readonly AgentRegistration[],
): string[] {
  const targets = new Set<string>();
  for (const mention of msg.mentions ?? []) {
    const candidates = [mention.openId, mention.name].filter((value): value is string => Boolean(value));
    for (const agent of agents) {
      const identities = [agent.id, agent.displayName, ...(agent.aliases ?? [])];
      if (candidates.some((candidate) => identities.some((identity) => equalIdentity(candidate, identity)))) {
        targets.add(agent.id);
      }
    }
  }
  return [...targets];
}

export function parseAgentRoster(raw: string | undefined): AgentRegistration[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const value = entry as Partial<AgentRegistration>;
      if (typeof value.id !== 'string' || typeof value.displayName !== 'string') return [];
      return [{
        id: value.id,
        displayName: value.displayName,
        ...(Array.isArray(value.aliases) ? { aliases: value.aliases.filter((alias): alias is string => typeof alias === 'string') } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function equalIdentity(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase());
}
