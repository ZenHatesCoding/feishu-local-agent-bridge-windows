import { promptSection } from '../agent/prompt';
import type { AgentIdentity, ContextEntry, Dispatch, SharedArtifact, TaskProjection } from '../collab/types';

/**
 * LAN workbench variant of the collaboration context envelope. Same envelope
 * shape and marker vocabulary as the Feishu bridge, but the rules describe
 * the workbench channel: no Feishu topics, no lark-cli, files resolve through
 * the center's authorized download endpoint.
 */
export function buildLanCollaborationContext(input: {
  deploymentId: string;
  task: TaskProjection;
  dispatch: Dispatch;
  entries: ContextEntry[];
  artifacts?: SharedArtifact[];
  agents?: AgentIdentity[];
  fileUrl?: (fileId: string) => string;
}): string {
  const scope = 'conversationId' in input.task.address ? input.task.address.conversationId : input.task.id;
  const fileUrl = input.fileUrl ?? ((fileId: string) => `api/files/${fileId}`);
  return promptSection('collaboration_context', {
    contract: {
      taskId: input.task.id,
      currentOwner: input.task.ownerAgentId,
      yourDispatch: input.dispatch,
      mentionTargets: (input.agents ?? []).map(({ id, displayName }) => ({ id, displayName })),
      rules: [
        'Use the current dispatch and triggering message first. Do not assume a complete conversation history is in this prompt.',
        `This is a LAN workbench conversation (${scope}). Every participant reads the same Hub-filtered context; there is no platform search to fall back on.`,
        'Task files are listed under artifacts with their sha256. Download them through the center with the file id; a local path from another computer is never valid on yours.',
        'Do not expose private runtime traces or chain-of-thought.',
        'mentionTargets is the Hub roster observed in this conversation. It is not a member directory: a missing name means unknown, never that the agent is absent.',
        'To invite an agent to reply, output exactly one <collaboration_reply target="TARGET_ID">brief invitation</collaboration_reply> marker in your final answer. For consultation output <collaboration_ask target="TARGET_ID">question and essential context</collaboration_ask>; for a work transfer output <collaboration_handoff target="TARGET_ID">objective and essential conclusions</collaboration_handoff>. The center consumes the marker and creates the authorization dispatch; the workbench renders the mention.',
        'Never write @Name inside the marker; TARGET_ID must come from mentionTargets.',
        'If yourDispatch.reason is ask, finish the requested consultation with the result and artifact references only. Do not emit collaboration_reply, collaboration_ask or collaboration_handoff: the worker records the return and the current owner is woken.',
        'Complete only the assigned objective and return structured results and artifact references.',
        `To share a task file, publish it as an artifact (kind: file, locator: {provider: "object", uri: "${fileUrl('<file-id>')}"}); the receiving worker downloads and verifies the digest before use.`,
      ],
    },
    artifacts: (input.artifacts ?? []).map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      kind: artifact.kind,
      sha256: artifact.sha256,
      size: artifact.size,
      ...(artifact.mime ? { mime: artifact.mime } : {}),
      ...(artifact.locator ? { locator: artifact.locator } : {}),
    })),
    localJournal: { scope, command: 'workbench conversation timeline' },
  });
}
