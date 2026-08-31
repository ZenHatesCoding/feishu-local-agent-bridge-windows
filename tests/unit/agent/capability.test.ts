import { describe, expect, it } from 'vitest';
import { BRIDGE_SYSTEM_PROMPT } from '../../../src/agent/bridge-system-prompt';
import { antigravityCapability, claudeCapability, codexCapability, deepSeekHarnessCapability, effectiveReplyMode, usesFinalOutputDelivery } from '../../../src/agent/capability';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

describe('agent capability contract', () => {
  it('defines Claude capability with legacy callback marker compatibility', () => {
    const capability = claudeCapability();

    expect(capability).toMatchObject({
      agentId: 'claude',
      sessionKind: 'claude-session',
      promptInjection: 'append-system-prompt',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: ['__claude_cb'],
      },
    });
  });

  it('defines Codex capability with thread sessions and stdin prompt injection', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    expect(codexCapability(profile)).toMatchObject({
      agentId: 'codex',
      sessionKind: 'codex-thread',
      promptInjection: 'stdin-prefix',
      supportsNativeHistory: false,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      permissions: {
        maxAccess: 'workspace',
      },
    });
  });

  it('uses Codex profile max access as the static capability ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });

    expect(codexCapability(profile).permissions.maxAccess).toBe('read-only');
  });

  it('marks DeepSeek Harness as final-output so delivery never relies on a long-lived stream', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'deepseek-harness',
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
      deepseekHarness: { binaryPath: 'node', entryPath: '/harness/cli.js' },
    });

    expect(deepSeekHarnessCapability(profile)).toMatchObject({
      agentId: 'deepseek-harness',
      outputDelivery: 'final',
    });
    expect(effectiveReplyMode(deepSeekHarnessCapability(profile), 'markdown')).toBe('text');
  });

  it('marks Antigravity as final-output and acknowledges it at intake', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'antigravity',
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
      antigravity: { binaryPath: 'agy' },
    });

    expect(antigravityCapability(profile)).toMatchObject({
      agentId: 'antigravity',
      outputDelivery: 'final',
    });
    expect(effectiveReplyMode(antigravityCapability(profile), 'markdown')).toBe('text');
    expect(usesFinalOutputDelivery('antigravity')).toBe(true);
  });
});
