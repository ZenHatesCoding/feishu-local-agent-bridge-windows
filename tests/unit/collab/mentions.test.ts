import { describe, expect, it } from 'vitest';
import { stripTargetMentionPrefix } from '../../../src/collab/mentions';

describe('bridge collaboration mention rendering', () => {
  const justice = { openId: 'ou_ae9b3ab812ab5380a4a58b888b2e9985', displayName: 'Justice' };

  it('removes a model-generated target address before the bridge emits its real mention', () => {
    expect(stripTargetMentionPrefix(
      '@ou_ae9b3ab812ab5380a4a58b888b2e9985 Justice，Sun 已完成第 2 页并交付。',
      justice,
    )).toBe('Sun 已完成第 2 页并交付。');
  });

  it('removes only a leading address and preserves body references', () => {
    expect(stripTargetMentionPrefix(
      '@Justice 请检查第 3 页；正文中保留 @Justice 的审查结论。',
      justice,
    )).toBe('请检查第 3 页；正文中保留 @Justice 的审查结论。');
  });

  it('removes a leading raw id token even when it is not the recipient open_id', () => {
    expect(stripTargetMentionPrefix(
      '@ou_ffffffffffffffffffffffffffffffff Justice，请接手。',
      justice,
    )).toBe('请接手。');
  });

  it('does not erase content that is only an address', () => {
    expect(stripTargetMentionPrefix('@Justice', justice)).toBe('@Justice');
  });
});
