import { it, expect } from 'vitest';
import { canReceiveAllGroupMessages } from '../../../src/bot/app-scope';
it('distinguishes receiving all group messages from merely receiving mentions', () => {
  expect(canReceiveAllGroupMessages(new Set(['im:message.group_at_msg:readonly']))).toBe(false);
  expect(canReceiveAllGroupMessages(new Set(['im:message.group_msg']))).toBe(true);
  expect(canReceiveAllGroupMessages(new Set(['im:message.group_msg:readonly']))).toBe(true);
});
