import { describe, expect, it } from 'vitest';
import { taskIdFor } from '../../../src/collab/task-id';

describe('taskIdFor', () => {
  it('uses the Feishu tenant, chat, and topic as a stable task address', () => {
    const address = { tenantKey: 'tenant', chatId: 'chat', threadId: 'topic' };
    expect(taskIdFor(address)).toBe(taskIdFor({ ...address }));
    expect(taskIdFor({ ...address, threadId: 'other' })).not.toBe(taskIdFor(address));
  });

  it('rejects non-topic collaboration', () => {
    expect(() => taskIdFor({ tenantKey: 't', chatId: 'c', threadId: '' }))
      .toThrow('must use Feishu topics');
  });
});
