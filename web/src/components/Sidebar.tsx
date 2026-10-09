import { useState } from 'react';
import type { LanConversationInfo } from '../api';
import type { StreamStatus } from '../stream';

const STATUS_LABEL: Record<StreamStatus, string> = {
  connecting: '连接中…',
  live: '实时',
  reconnecting: '重连中…',
  stopped: '未连接',
};

export function Sidebar(props: {
  username: string;
  conversations: LanConversationInfo[];
  activeId?: string;
  streamStatus: StreamStatus;
  onSelect: (id: string) => void;
  onCreate: (title: string) => void;
  onLogout: () => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <span className="brand">LAN Workbench</span>
        <span className={`stream stream-${props.streamStatus}`}>{STATUS_LABEL[props.streamStatus]}</span>
      </header>
      <div className="sidebar-user">
        <span>{props.username}</span>
        <button className="ghost" onClick={props.onLogout}>
          退出
        </button>
      </div>
      <ul className="conversation-list">
        {props.conversations.map((conversation) => (
          <li
            key={conversation.id}
            className={conversation.id === props.activeId ? 'active' : ''}
            onClick={() => props.onSelect(conversation.id)}
          >
            <span className="title">{conversation.title || conversation.id}</span>
            <span className={`state state-${conversation.state}`}>{conversation.state}</span>
          </li>
        ))}
      </ul>
      <form
        className="new-conversation"
        onSubmit={(event) => {
          event.preventDefault();
          const value = title.trim();
          if (!value) return;
          props.onCreate(value);
          setTitle('');
        }}
      >
        <input
          placeholder="新会话标题"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <button type="submit" disabled={!title.trim()}>
          创建
        </button>
      </form>
    </aside>
  );
}
