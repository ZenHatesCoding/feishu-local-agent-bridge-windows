import { describe, expect, it } from 'vitest';
import { taskIdFor, taskAddressForMessage } from '../../../src/collab/task-id';

describe('taskIdFor', () => {
  it('uses the Feishu tenant, chat, and topic as a stable task address', () => {
    const address = { tenantKey: 'tenant', chatId: 'chat', threadId: 'topic' };
    expect(taskIdFor(address)).toBe(taskIdFor({ ...address }));
    expect(taskIdFor({ ...address, threadId: 'other' })).not.toBe(taskIdFor(address));
  });

  it('requires an explicit conversation boundary on raw protocol inputs', () => {
    expect(() => taskIdFor({ tenantKey: 't', chatId: 'c', threadId: '' }))
      .toThrow('_chat group boundary');
  });
  it('isolates ordinary groups from one another and from their topics', () => {
    const group = taskAddressForMessage('t', { chatId: 'group-a' });
    expect(group.threadId).toBe('_chat');
    expect(taskIdFor(group)).not.toBe(taskIdFor(taskAddressForMessage('t', { chatId: 'group-b' })));
    expect(taskIdFor(group)).not.toBe(taskIdFor(taskAddressForMessage('t', { chatId: 'group-a', threadId: 'omt-real' })));
  });
});
