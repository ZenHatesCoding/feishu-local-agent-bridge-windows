import { promptSection } from '../agent/prompt';
import type { AgentIdentity, ContextEntry, Dispatch, SharedArtifact, TaskProjection } from './types';

/** A small envelope; each computer retrieves its own observed history on demand. */
export function buildCollaborationContext(input: {
  task: TaskProjection;
  dispatch: Dispatch;
  entries: ContextEntry[];
  artifacts?: SharedArtifact[];
  agents?: AgentIdentity[];
}): string {
  const scope = input.task.address.threadId
    ? `${input.task.address.chatId}:${input.task.address.threadId}`
    : input.task.address.chatId;
  return promptSection('collaboration_context', {
    contract: {
      taskId: input.task.id,
      currentOwner: input.task.ownerAgentId,
      yourDispatch: input.dispatch,
      availableAgents: (input.agents ?? []).map(({ id, displayName }) => ({ id, displayName })),
      rules: [
        'Use the current dispatch and triggering message first. Do not assume a complete group history is in this prompt.',
        `This computer keeps its own observed topic ledger. Search relevant local records with: lark-channel-bridge local-context search --scope "${scope}" --query "<keywords>". Read the latest local records with: lark-channel-bridge local-context read --scope "${scope}".`,
        'A local attachment path is valid only on this computer. For a missing file or earlier message, use its Feishu message reference or ask the sender to resend it; never invent a remote local path.',
        'Do not expose private runtime traces or chain-of-thought.',
        'A normal group-chat turn may invite one participant with: collab-delegate.cmd reply --target TARGET_ID --content TEXT. It grants one reply turn and sends the real Feishu @ without transferring work ownership.',
        'For explicit work transfer or consultation, run: collab-delegate.cmd handoff|ask --target TARGET_ID --content TEXT.',
        'Never use a bare lark-cli message or text-only @ to delegate: it cannot authorize work.',
        'For an ask, the target records its answer with hub return, then really @ mentions the current owner.',
        'Complete only the assigned objective and return structured results and artifact paths.',
        `For every task file you create and send, run: collab-artifact.cmd publish --task ${input.task.id} --actor ${input.dispatch.targetAgentId} --path "<absolute-or-relative-path>" --reply-to "<latest bridge_context.messageIds value>" --reply-in-thread. Do not use raw lark-cli --file in a collaboration task.`,
      ],
    },
    localJournal: { scope, command: 'lark-channel-bridge local-context' },
  });
}
