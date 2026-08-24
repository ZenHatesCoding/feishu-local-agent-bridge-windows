import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('collaboration design and Windows operations contract', () => {
  it('preserves the control-plane and context-isolation principles', async () => {
    const design = await readFile(
      new URL('../../../docs/DESIGN.zh-CN.md', import.meta.url),
      'utf8',
    );
    for (const phrase of [
      '共享任务状态，不共享脑内会话',
      '话题就是任务边界',
      '必须同时成立的双钥匙',
      '真实 `@`',
      'dispatch',
      'task-public',
      'private-runtime',
      'secret',
      'collaboration_context',
      '不是操作系统强隔离',
      '文件不是文字附注，而是一等共享产物',
      'collab-artifact.cmd publish',
      'SHA-256',
    ]) {
      expect(design).toContain(phrase);
    }
  });

  it('keeps portable setup, per-agent, all-agent, logging, and rollback controls', async () => {
    const operations = await readFile(
      new URL('../../../docs/WINDOWS_OPERATIONS.zh-CN.md', import.meta.url),
      'utf8',
    );
    for (const phrase of [
      'Setup-CollabPilot.ps1',
      'Test-CollabPilotConfig.ps1',
      'collaboration-pilot.example.json',
      '.runtime\\pilot.local.json',
      'Start-CollabPilot.ps1',
      'Start-CollabAgent.ps1 -Agent planner',
      'Status-CollabPilot.ps1',
      'Get-CollabPilotLog.ps1',
      'Stop-CollabAgent.ps1',
      'Stop-CollabPilot.ps1 -RestoreOriginals',
      '项目不会安装、重装或升级用户的 Agent',
    ]) {
      expect(operations).toContain(phrase);
    }
  });
});
