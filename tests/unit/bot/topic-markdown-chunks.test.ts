import { describe, expect, it } from 'vitest';
import { splitMarkdownForTopic } from '../../../src/bot/channel.js';

describe('topic markdown chunks', () => {
  it('keeps a long topic reply within the Feishu message limit', () => {
    const body = `${'第一段内容 '.repeat(800)}\n\n${'第二段内容 '.repeat(800)}`;

    const chunks = splitMarkdownForTopic(body);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 3500)).toBe(true);
    expect(chunks.join('\n\n')).toContain('第二段内容');
  });
});
