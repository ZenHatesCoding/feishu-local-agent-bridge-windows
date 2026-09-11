/**
 * The bridge owns the single real, structured Feishu mention for a delegated
 * message. Models still sometimes address the recipient by hand, e.g.
 * `@ou_xxx` or `@ou_xxx DisplayName`; Feishu then renders that raw text next
 * to the bridge's own mention, so the hand-written half shows up as a second,
 * unreadable @. Remove only a leading address aimed at the recipient, never
 * ordinary @ references inside the body of the work.
 */
export function stripTargetMentionPrefix(
  content: string,
  identity: { openId: string; displayName: string },
): string {
  const addresses = [
    identity.openId ? `@${escapeRegExp(identity.openId)}` : undefined,
    identity.displayName ? `@${escapeRegExp(identity.displayName)}` : undefined,
    // A raw id token (stale, or copied for a different agent) is never
    // legitimate opening text either.
    '@o[ncun]_[A-Za-z0-9]+',
  ].filter((address): address is string => Boolean(address));
  const addressAtStart = new RegExp(`^\\s*(?:${addresses.join('|')})[\\s，,：:、-]*`, 'i');

  let stripped = content;
  for (let next = stripped.replace(addressAtStart, ''); next !== stripped;) {
    stripped = next;
    next = stripped.replace(addressAtStart, '');
  }

  // `@ou_xxx DisplayName，…` may name the recipient right after the address.
  if (identity.displayName) {
    const nameAtStart = new RegExp(`^\\s*${escapeRegExp(identity.displayName)}\\s*[，,：:]?\\s*`, 'i');
    const withoutName = stripped.replace(nameAtStart, '');
    if (withoutName.trim()) stripped = withoutName;
  }

  // Content that is nothing but an address keeps its text rather than vanishing.
  return stripped.trim() || content;
}

/** Raw Feishu IDs have no user-facing meaning and must never render in a group reply. */
export function stripRawFeishuMentionTokens(content: string): string {
  return content.replace(/@o(?:u|c|n)_[A-Za-z0-9]+/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
