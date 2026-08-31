import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import type { MessageReplyMode } from '../config/schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'antigravity' | 'deepseek-harness';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'stateless';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';
export type OutputDeliveryMode = 'incremental' | 'final';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  outputDelivery: OutputDeliveryMode;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    outputDelivery: 'incremental',
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    outputDelivery: 'incremental',
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function antigravityCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'antigravity',
    sessionKind: 'stateless',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    outputDelivery: 'final',
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function deepSeekHarnessCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return {
    ...antigravityCapability(profile),
    agentId: 'deepseek-harness',
    outputDelivery: 'final',
  };
}

export function effectiveReplyMode(
  capability: Pick<AgentCapability, 'outputDelivery'>,
  configured: MessageReplyMode,
): MessageReplyMode {
  return capability.outputDelivery === 'final' ? 'text' : configured;
}

export function usesFinalOutputDelivery(agentKind: ProfileConfig['agentKind']): boolean {
  return agentKind === 'antigravity' || agentKind === 'deepseek-harness';
}
