import { createHash } from 'node:crypto';
import type { TaskAddress } from './types';

export function validateTaskAddress(address: TaskAddress): void {
  if (!address.tenantKey.trim()) throw new Error('tenantKey is required');
  if (!address.chatId.trim()) throw new Error('chatId is required');
  if (!address.threadId.trim()) {
    throw new Error('threadId is required: collaboration tasks must use Feishu topics');
  }
}

export function taskIdFor(address: TaskAddress): string {
  validateTaskAddress(address);
  const canonical = `${address.tenantKey}\u0000${address.chatId}\u0000${address.threadId}`;
  return `task_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}
