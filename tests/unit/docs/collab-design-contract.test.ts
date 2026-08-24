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
    ]) {
      expect(design).toContain(phrase);
    }
  });

  it('keeps documented per-agent, all-agent, logging, and rollback controls', async () => {
    const operations = await readFile(
      new URL('../../../docs/WINDOWS_OPERATIONS.zh-CN.md', import.meta.url),
      'utf8',
    );
    for (const phrase of [
      'Start-CollabPilot.ps1',
      'Start-CollabAgent.ps1 -Agent world',
      'Start-CollabAgent.ps1 -Agent justice',
      'Start-CollabAgent.ps1 -Agent chariot',
      'Start-CollabAgent.ps1 -Agent fool',
      'Status-CollabPilot.ps1',
      'Get-CollabPilotLog.ps1',
      'Stop-CollabAgent.ps1',
      'Stop-CollabPilot.ps1 -RestoreOriginals',
    ]) {
      expect(operations).toContain(phrase);
    }
  });
});
