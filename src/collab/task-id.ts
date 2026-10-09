import { createHash } from 'node:crypto';
import type { TaskAddress } from './types';

export function validateTaskAddress(address: TaskAddress): void {
  if ('conversationId' in address) {
    if (!address.deploymentId.trim()) throw new Error('deploymentId is required');
    if (!address.conversationId.trim()) {
      throw new Error('conversationId is required: collaboration tasks need a stable conversation boundary');
    }
    return;
  }
  if (!address.tenantKey.trim()) throw new Error('tenantKey is required');
  if (!address.chatId.trim()) throw new Error('chatId is required');
  if (!address.threadId.trim()) {
    throw new Error('threadId is required: collaboration tasks must use Feishu topics');
  }
}

export function taskIdFor(address: TaskAddress): string {
  validateTaskAddress(address);
  const canonical = 'conversationId' in address
    ? `lan\u0000${address.deploymentId}\u0000${address.conversationId}`
    : `${address.tenantKey}\u0000${address.chatId}\u0000${address.threadId}`;
  return `task_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}
