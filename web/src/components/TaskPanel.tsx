import type { LanStoredFileInfo } from '../api';

const DISPATCH_LABEL: Record<string, string> = {
  mention: '指派',
  handoff: '移交',
  ask: '咨询',
  return: '唤醒',
};

export function TaskPanel(props: {
  task?: { id: string; status: string; participants: string[]; ownerAgentId?: string };
  dispatches: Array<{ id: string; targetAgentId: string; reason: string; status: string; objective: string }>;
  files: LanStoredFileInfo[];
  onFileDownload: (fileId: string) => void;
}): JSX.Element {
  return (
    <aside className="task-panel">
      <section>
        <h3>任务状态</h3>
        {props.task ? (
          <dl className="task-meta">
            <dt>状态</dt>
            <dd>
              <span className={`state state-${props.task.status}`}>{props.task.status}</span>
            </dd>
            <dt>当前 Owner</dt>
            <dd>{props.task.ownerAgentId ?? '—'}</dd>
            <dt>参与者</dt>
            <dd>{props.task.participants.join('、') || '—'}</dd>
          </dl>
        ) : (
          <p className="hint">等待会话活动后生成任务</p>
        )}
      </section>
      <section>
        <h3>派发</h3>
        {props.dispatches.length === 0 ? (
          <p className="hint">暂无派发</p>
        ) : (
          <ul className="dispatch-list">
            {props.dispatches.map((dispatch) => (
              <li key={dispatch.id}>
                <header>
                  <strong>{dispatch.targetAgentId}</strong>
                  <span className={`dispatch-status status-${dispatch.status}`}>
                    {DISPATCH_LABEL[dispatch.reason] ?? dispatch.reason} · {dispatch.status}
                  </span>
                </header>
                <p>{dispatch.objective}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>会话文件</h3>
        {props.files.length === 0 ? (
          <p className="hint">暂无文件</p>
        ) : (
          <ul className="file-list">
            {props.files.map((file) => (
              <li key={file.id}>
                <button className="file-card" onClick={() => props.onFileDownload(file.id)}>
                  <span className="file-name">{file.name}</span>
                  <span className="file-meta">
                    {file.size} B · {file.sha256.slice(0, 10)}…
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
