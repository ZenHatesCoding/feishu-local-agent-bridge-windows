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
      mentionTargets: (input.agents ?? []).map(({ id, displayName }) => ({ id, displayName })),
      rules: [
        'Use the current dispatch and triggering message first. Do not assume a complete group history is in this prompt.',
        `This computer keeps its own observed topic ledger. Search relevant local records with: lark-channel-bridge local-context search --scope "${scope}" --query "<keywords>". Read the latest local records with: lark-channel-bridge local-context read --scope "${scope}".`,
        'A local attachment path is valid only on this computer. For a missing file or earlier message, use its Feishu message reference or ask the sender to resend it; never invent a remote local path.',
        'Do not expose private runtime traces or chain-of-thought.',
        'mentionTargets is the Hub roster observed in this Feishu group. It is not a member directory: a missing name means unknown, never that the bot is absent from the group.',
        'To invite a bot to reply, output exactly one <collaboration_reply target="TARGET_ID">brief invitation</collaboration_reply> marker in your final answer. For consultation output <collaboration_ask target="TARGET_ID">question and essential context</collaboration_ask>; for a work transfer output <collaboration_handoff target="TARGET_ID">objective and essential conclusions</collaboration_handoff>. The Bridge consumes the marker, replies in this topic, creates the authorization dispatch, and emits the one real Feishu @.',
        'Never call lark-cli, a group-member API, or use an open_id for bot-to-bot mentions. Never write @Name or @open_id inside the marker; TARGET_ID must come from mentionTargets.',
        'If yourDispatch.reason is ask, finish the requested consultation with the result and artifact paths only. Do not emit collaboration_reply, collaboration_ask or collaboration_handoff: the Bridge records the return and sends the one real @ to the current owner.',
        'Complete only the assigned objective and return structured results and artifact paths.',
        `For every task file you create and send, run: collab-artifact.cmd publish --task ${input.task.id} --actor ${input.dispatch.targetAgentId} --path "<absolute-or-relative-path>" --reply-to "<latest bridge_context.messageIds value>" --reply-in-thread. Do not use raw lark-cli --file in a collaboration task.`,
      ],
    },
    localJournal: { scope, command: 'lark-channel-bridge local-context' },
  });
}
