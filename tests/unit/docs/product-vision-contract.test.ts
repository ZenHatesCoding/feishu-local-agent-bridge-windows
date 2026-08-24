import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('multi-agent product vision contract', () => {
  it('keeps the product north star linked from entry and architecture docs', async () => {
    const [readme, architecture] = await Promise.all([
      readFile(new URL('../../../README.md', import.meta.url), 'utf8'),
      readFile(new URL('../../../docs/DESIGN.md', import.meta.url), 'utf8'),
    ]);
    expect(readme).toContain('PRODUCT_VISION.md');
    expect(readme).toContain('PRODUCT_VISION.zh-CN.md');
    expect(architecture).toContain('PRODUCT_VISION.md');
    expect(architecture).toContain('PRODUCT_VISION.zh-CN.md');
  });

  it('preserves the user-facing goal and non-negotiable acceptance criteria', async () => {
    const vision = await readFile(
      new URL('../../../docs/PRODUCT_VISION.zh-CN.md', import.meta.url),
      'utf8',
    );
    for (const phrase of [
      '一个飞书话题就是一个任务',
      '不需要手工复制上一位 Agent 的上下文',
      'handoff',
      'ask',
      'return',
      'complete',
      '不能获得第一个 Agent 的私有思维链',
      '不会形成机器人互相唤醒循环',
      'Hermes 不被重装',
      '后续获准接手的 Agent 可以直接读取',
      '让用户在 Agent 之间复制粘贴完整聊天记录',
    ]) {
      expect(vision).toContain(phrase);
    }
  });
});
