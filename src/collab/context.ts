import { promptSection } from '../agent/prompt';
import type { AgentIdentity, ContextEntry, Dispatch, SharedArtifact, TaskProjection } from './types';

export function buildCollaborationContext(input: {
  task: TaskProjection;
  dispatch: Dispatch;
  entries: ContextEntry[];
  artifacts?: SharedArtifact[];
  agents?: AgentIdentity[];
}): string {
  return promptSection('collaboration_context', {
    contract: {
      taskId: input.task.id,
      currentOwner: input.task.ownerAgentId,
      yourDispatch: input.dispatch,
      availableAgents: (input.agents ?? []).map(({ id, displayName }) => ({ id, displayName })),
      rules: [
        'Treat accepted decisions and referenced artifacts as shared task state.',
        'Do not expose private runtime traces or chain-of-thought.',
        'To delegate, run: collab-delegate.cmd handoff|ask --target TARGET_ID --content TEXT. It authorizes the Hub action and sends the real Feishu @ in this topic.',
        'Never use a bare lark-cli message or text-only @ to delegate: it cannot authorize work.',
        'For an ask, the target records its answer with hub return, then really @ mentions the current owner.',
        'Complete only the assigned objective and return structured results and artifact paths.',
        `For every task file you create and send, run: collab-artifact.cmd publish --task ${input.task.id} --actor ${input.dispatch.targetAgentId} --path "<absolute-or-relative-path>" --reply-to "<latest bridge_context.messageIds value>" --reply-in-thread. Do not use raw lark-cli --file in a collaboration task.`,
        'Files listed in artifacts are durable shared copies. Read localPath directly and verify sha256 when integrity matters.',
      ],
    },
    artifacts: input.artifacts ?? [],
    entries: input.entries,
  });
}
