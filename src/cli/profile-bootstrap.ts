import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentPreflightError } from '../agent/preflight';
import { DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT } from '../agent/antigravity/adapter';
import { createDefaultProfileConfig, type AgentKind, type ProfileConfig } from '../config/profile-schema';
import type { AppConfig } from '../config/schema';
import { resolveWorkingDirectory } from '../policy/workspace';
import { resolveExecutablePath } from './agent-detection';

export interface BootstrapProfileInput {
  agentKind: AgentKind;
  accounts: AppConfig['accounts'];
  preferences?: AppConfig['preferences'];
  secrets?: AppConfig['secrets'];
  workspace?: string;
  defaultWorkspace?: string;
  codexBinaryPath?: string;
  antigravityBinaryPath?: string;
  deepseekHarnessBinaryPath?: string;
  deepseekHarnessEntryPath?: string;
  profileDir?: string;
}

export async function createBootstrapProfileConfig(
  input: BootstrapProfileInput,
): Promise<ProfileConfig> {
  const workspace = input.workspace
    ? await resolveBootstrapWorkspace(input.workspace)
    : input.defaultWorkspace
      ? await ensureManagedDefaultWorkspace(input.defaultWorkspace)
      : undefined;
  const codex =
    input.agentKind === 'codex'
      ? await createBootstrapCodexConfig(input.codexBinaryPath)
      : undefined;
  const antigravity =
    input.agentKind === 'antigravity'
      ? await createBootstrapAntigravityConfig(input.antigravityBinaryPath)
      : undefined;
  const deepseekHarness =
    input.agentKind === 'deepseek-harness'
      ? await createBootstrapDeepSeekHarnessConfig(
          input.deepseekHarnessBinaryPath,
          input.deepseekHarnessEntryPath,
        )
      : undefined;
  const profile = createDefaultProfileConfig({
    agentKind: input.agentKind,
    accounts: input.accounts,
    preferences: input.preferences,
    secrets: input.secrets,
    ...(codex ? { codex } : {}),
    ...(antigravity ? { antigravity } : {}),
    ...(deepseekHarness ? { deepseekHarness } : {}),
  });
  if (workspace) {
    profile.workspaces = {
      ...profile.workspaces,
      default: workspace,
    };
  }
  if (input.profileDir && profile.codex?.inheritCodexHome === false) {
    await mkdir(join(input.profileDir, 'codex-home'), { recursive: true });
  }
  return profile;
}

export async function resolveBootstrapWorkspace(workspace: string): Promise<string> {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}

async function ensureManagedDefaultWorkspace(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}

export async function createBootstrapCodexConfig(binaryPath: string | undefined) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex';
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: codexBootstrapBinaryErrorCode(errno),
      agentId: 'codex',
      agentName: 'Codex CLI',
      command,
      binaryPath: command,
      errno,
    });
  }
  return { binaryPath: resolvedBinary };
}

export async function createBootstrapAntigravityConfig(binaryPath: string | undefined) {
  const command =
    binaryPath ??
    process.env.LARK_CHANNEL_ANTIGRAVITY_BIN ??
    (process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
      : 'agy');
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: codexBootstrapBinaryErrorCode(errno),
      agentId: 'antigravity',
      agentName: 'Antigravity CLI',
      command,
      binaryPath: command,
      errno,
    });
  }
  return {
    binaryPath: resolvedBinary,
    printTimeout: DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT,
    dangerouslySkipPermissions: true,
  };
}

export async function createBootstrapDeepSeekHarnessConfig(
  binaryPath: string | undefined,
  entryPath: string | undefined,
) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_NODE_BIN ?? 'node';
  const entry = entryPath ?? process.env.LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY;
  if (!entry) throw new Error('LARK_CHANNEL_DEEPSEEK_HARNESS_ENTRY is required for deepseek-harness');
  const resolvedBinary = await resolveExecutablePath(command).catch((err: NodeJS.ErrnoException) => {
    const errno = err.code;
    throw new AgentPreflightError({
      code: codexBootstrapBinaryErrorCode(errno),
      agentId: 'deepseek-harness',
      agentName: 'DeepSeek Harness',
      command,
      binaryPath: command,
      errno,
    });
  });
  return { binaryPath: resolvedBinary, entryPath: entry };
}

function codexBootstrapBinaryErrorCode(errno: string | undefined) {
  if (errno === 'EACCES' || errno === 'EPERM') return 'agent-binary-not-executable';
  if (errno === 'ELOOP' || errno === 'ENOTDIR' || errno === 'EINVAL') {
    return 'agent-binary-resolve-failed';
  }
  return 'agent-binary-not-found';
}
