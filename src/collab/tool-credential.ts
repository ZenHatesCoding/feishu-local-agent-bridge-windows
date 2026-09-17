/**
 * Returns the caller's agent-scoped Hub credential.
 *
 * Model runtimes commonly scrub ambient secret-shaped environment names before
 * launching a shell tool.  Pilot therefore projects the same per-agent
 * capability into the deliberately tool-safe name below.  The value is never
 * written to collaboration state; it only crosses the local process boundary
 * required for an authorized agent to publish or register its own work.
 */
export const COLLAB_TOOL_HUB_CREDENTIAL_ENV = 'LARK_COLLAB_TOOL_HUB_CREDENTIAL';

export function collaborationHubCredential(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return nonEmpty(env.LARK_COLLAB_HUB_TOKEN) ?? nonEmpty(env[COLLAB_TOOL_HUB_CREDENTIAL_ENV]);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
