import { useRef, useState } from 'react';
import type { LanAgentInfo } from '../api';

export function Composer(props: {
  agents: LanAgentInfo[];
  disabled: boolean;
  onSend: (content: string, targets: string[]) => void;
  onUpload: (file: File) => void;
}): JSX.Element {
  const [content, setContent] = useState('');
  const [targets, setTargets] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const toggleTarget = (agentId: string): void => {
    setTargets((previous) =>
      previous.includes(agentId) ? previous.filter((item) => item !== agentId) : [...previous, agentId],
    );
  };

  return (
    <footer className="composer">
      <div className="composer-agents">
        {props.agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={`chip ${targets.includes(agent.id) ? 'selected' : ''} ${agent.online ? 'online' : ''}`}
            onClick={() => toggleTarget(agent.id)}
          >
            @{agent.displayName}
          </button>
        ))}
      </div>
      <div className="composer-row">
        <textarea
          placeholder="输入消息，选择要 @ 的 Agent（未选择时不派发，仅记录）"
          value={content}
          disabled={props.disabled}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && content.trim()) {
              props.onSend(content.trim(), targets);
              setContent('');
            }
          }}
        />
        <div className="composer-actions">
          <button type="button" className="ghost" disabled={props.disabled} onClick={() => fileInput.current?.click()}>
            附件
          </button>
          <button
            type="button"
            className="primary"
            disabled={props.disabled || !content.trim()}
            onClick={() => {
              const value = content.trim();
              if (!value) return;
              props.onSend(value, targets);
              setContent('');
            }}
          >
            发送
          </button>
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          for (const file of event.target.files ?? []) props.onUpload(file);
          event.target.value = '';
        }}
      />
    </footer>
  );
}
