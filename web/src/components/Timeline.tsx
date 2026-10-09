import { useEffect, useRef } from 'react';
import type { LanAgentInfo } from '../api';
import type { TimelineItem } from '../timeline';

const ACTION_LABEL: Record<string, string> = {
  handoff: '移交',
  ask: '咨询',
  reply: '邀请回复',
  return: '回复',
  complete: '完成',
};

function displayName(agentId: string | undefined, agents: LanAgentInfo[]): string {
  if (!agentId) return '未知 Agent';
  return agents.find((agent) => agent.id === agentId)?.displayName ?? agentId;
}

export function Timeline(props: { items: TimelineItem[]; agents: LanAgentInfo[] }): JSX.Element {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [props.items]);

  return (
    <div className="timeline">
      {props.items.map((item) => {
        if (item.kind === 'userMessage') {
          return (
            <article key={item.key} className="bubble user">
              <header>
                <strong>{item.username}</strong>
                {item.mentions.length > 0 ? (
                  <span className="mentions">
                    {item.mentions.map((agentId) => (
                      <span key={agentId} className="mention">
                        @{displayName(agentId, props.agents)}
                      </span>
                    ))}
                  </span>
                ) : null}
              </header>
              <p>{item.content}</p>
            </article>
          );
        }
        if (item.kind === 'agentAction') {
          return (
            <article key={item.key} className={`bubble agent action-${item.action}`}>
              <header>
                <span className={`badge badge-${item.action}`}>
                  {ACTION_LABEL[item.action] ?? item.action}
                </span>
                <strong>{displayName(item.actor, props.agents)}</strong>
                {item.target ? <span className="arrow">→</span> : null}
                {item.target ? <strong>{displayName(item.target, props.agents)}</strong> : null}
              </header>
              <p>{item.content}</p>
            </article>
          );
        }
        return (
          <article key={item.key} className={`run-block ${item.finished ? 'finished' : 'active'}`}>
            <header>
              <span className={`run-status run-${item.status === 'error' ? 'error' : item.finished ? 'ok' : 'live'}`}>
                {item.status === 'error' ? '运行出错' : item.finished ? '运行结束' : '正在运行'}
              </span>
              <strong>{displayName(item.agentId, props.agents)}</strong>
              <span className="run-id">{item.runId}</span>
            </header>
            {item.status && !item.finished ? <p className="run-status-line">{item.status}</p> : null}
            {item.text ? <pre className="run-text">{item.text}</pre> : null}
            {item.toolCalls.length > 0 ? (
              <ul className="tool-calls">
                {item.toolCalls.map((call) => (
                  <li key={call.id} className={call.isError ? 'tool-error' : ''}>
                    <span className="tool-name">{call.name}</span>
                    {call.output ? <pre>{call.output}</pre> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {item.error ? <p className="error">{item.error}</p> : null}
          </article>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
