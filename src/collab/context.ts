import { promptSection } from '../agent/prompt';
import type { ContextEntry, Dispatch, TaskProjection } from './types';

export function buildCollaborationContext(input: {
  task: TaskProjection;
  dispatch: Dispatch;
  entries: ContextEntry[];
}): string {
  return promptSection('collaboration_context', {
    contract: {
      taskId: input.task.id,
      currentOwner: input.task.ownerAgentId,
      yourDispatch: input.dispatch,
      rules: [
        'Treat accepted decisions and referenced artifacts as shared task state.',
        'Do not expose private runtime traces or chain-of-thought.',
        'Before waking another agent, run: lark-channel-bridge hub handoff|ask --task TASK_ID --actor YOUR_ID --target TARGET_ID --content TEXT.',
        'After the command succeeds, use a real Feishu @ in this topic to wake the target. Plain text @ alone is not authorization.',
        'For an ask, the target records its answer with hub return, then really @ mentions the current owner.',
        'Complete only the assigned objective and return structured results and artifact paths.',
      ],
    },
    entries: input.entries,
  });
}
