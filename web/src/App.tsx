import { useCallback, useEffect, useMemo, useState } from 'react';
import { LanApiClient, type LanAgentInfo, type LanConversationInfo, type LanStoredFileInfo } from './api';
import { ConversationState } from './timeline';
import { ConversationStream, type StreamStatus } from './stream';
import { Sidebar } from './components/Sidebar';
import { Timeline } from './components/Timeline';
import { Composer } from './components/Composer';
import { TaskPanel } from './components/TaskPanel';

const TOKEN_KEY = 'lan-workbench-token';

export function App(): JSX.Element {
  const client = useMemo(() => new LanApiClient(''), []);
  const [token, setToken] = useState<string | undefined>(undefined);
  const [username, setUsername] = useState('');
  const [agents, setAgents] = useState<LanAgentInfo[]>([]);
  const [conversations, setConversations] = useState<LanConversationInfo[]>([]);
  const [files, setFiles] = useState<LanStoredFileInfo[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [conversation, setConversation] = useState(new ConversationState());
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('stopped');
  const [error, setError] = useState<string | undefined>(undefined);

  const refreshConversations = useCallback(async (): Promise<void> => {
    try {
      const list = await client.conversations();
      setConversations(list.conversations);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [client]);

  const refreshFiles = useCallback(async (conversationId: string): Promise<void> => {
    try {
      const listing = await client.conversationFiles(conversationId);
      setFiles(listing.files);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [client]);

  const refreshAgents = useCallback(async (): Promise<void> => {
    try {
      const list = await client.agents();
      setAgents(list.agents);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [client]);

  // Restore session.
  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (!stored) return;
    client.setToken(stored);
    client
      .me()
      .then((result) => {
        setToken(stored);
        setUsername(result.user.displayName || result.user.username);
      })
      .catch(() => localStorage.removeItem(TOKEN_KEY));
  }, [client]);

  // Roster + conversation list polling (roster online state changes without events).
  useEffect(() => {
    if (!token) return;
    void refreshConversations();
    void refreshAgents();
    const timer = setInterval(() => {
      void refreshConversations();
      void refreshAgents();
    }, 5000);
    return () => clearInterval(timer);
  }, [token, refreshConversations, refreshAgents]);

  // Live stream for the active conversation.
  useEffect(() => {
    if (!token || !activeId) return;
    const state = new ConversationState();
    setConversation(state);
    void refreshFiles(activeId);
    const apply = (): void => setConversation(state.clone());
    const stream = new ConversationStream(client, activeId, () => state.cursor, {
      onLedgerRecord: (record) => {
        state.applyLedgerRecord(record);
        apply();
      },
      onRunRecord: (record) => {
        state.applyRunRecord(record);
        apply();
      },
      onTask: (task) => {
        state.applyTask(task);
        apply();
      },
      onStatusChange: setStreamStatus,
    });
    // Catch up first, then subscribe from the catch-up cursors.
    client
      .catchUp(activeId, 0, 0)
      .then((batch) => {
        state.applyCatchUp(batch);
        apply();
        stream.start();
      })
      .catch((err: Error) => setError(err.message));
    return () => stream.stop();
  }, [token, activeId, client, refreshFiles]);

  const handleLogin = useCallback(
    async (user: string, password: string): Promise<void> => {
      setError(undefined);
      try {
        const result = await client.login(user, password);
        client.setToken(result.token);
        localStorage.setItem(TOKEN_KEY, result.token);
        setToken(result.token);
        setUsername(result.user.displayName || result.user.username);
      } catch (err) {
        setError((err as LanApiErrorLike).message);
      }
    },
    [client],
  );

  const handleLogout = useCallback(async (): Promise<void> => {
    try {
      await client.logout();
    } catch {
      // best effort
    }
    client.setToken(undefined);
    localStorage.removeItem(TOKEN_KEY);
    setToken(undefined);
    setActiveId(undefined);
    setUsername('');
  }, [client]);

  const handleCreate = useCallback(
    async (title: string): Promise<void> => {
      try {
        const created = await client.createConversation(title);
        await refreshConversations();
        setActiveId(created.conversation.id);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [client, refreshConversations],
  );

  const handleSend = useCallback(
    async (content: string, targets: string[]): Promise<void> => {
      if (!activeId) return;
      try {
        await client.sendMessage(activeId, { content, targetAgentIds: targets });
        await refreshConversations();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [activeId, client, refreshConversations],
  );

  const handleCancel = useCallback(async (): Promise<void> => {
    if (!activeId) return;
    try {
      await client.cancel(activeId);
      await refreshConversations();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeId, client, refreshConversations]);

  const handleUpload = useCallback(
    async (file: File): Promise<void> => {
      if (!activeId) return;
      try {
        const uploaded = await client.uploadFile(activeId, file);
        setFiles((previous) => [...previous.filter((item) => item.id !== uploaded.file.id), uploaded.file]);
        void refreshFiles(activeId);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [activeId, client, refreshFiles],
  );

  const activeConversation = conversations.find((item) => item.id === activeId);

  if (!token) {
    return (
      <LoginScreen
        username={username}
        error={error}
        onSubmit={(user, password) => handleLogin(user, password)}
      />
    );
  }

  return (
    <div className="workbench">
      <Sidebar
        username={username}
        conversations={conversations}
        activeId={activeId}
        streamStatus={streamStatus}
        onSelect={setActiveId}
        onCreate={handleCreate}
        onLogout={handleLogout}
      />
      <main className="timeline-pane">
        {activeConversation ? (
          <>
            <header className="pane-header">
              <h2>{activeConversation.title || activeConversation.id}</h2>
              <span className={`state state-${activeConversation.state}`}>{activeConversation.state}</span>
              {activeConversation.state !== 'canceled' ? (
                <button className="ghost" onClick={() => void handleCancel()}>
                  取消任务
                </button>
              ) : null}
            </header>
            <Timeline items={conversation.timeline()} agents={agents} />
            <Composer
              agents={agents}
              onSend={(content, targets) => void handleSend(content, targets)}
              onUpload={(file) => void handleUpload(file)}
              disabled={activeConversation.state === 'canceled'}
            />
          </>
        ) : (
          <div className="empty">选择或创建一个会话开始协作</div>
        )}
      </main>
      <TaskPanel
        task={conversation.task}
        dispatches={conversation.dispatches()}
        files={files}
        onFileDownload={(fileId) => window.open(client.fileUrl(fileId), '_blank')}
      />
      {error ? (
        <div className="error-toast" onClick={() => setError(undefined)}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

interface LanApiErrorLike {
  message: string;
}

function LoginScreen(props: {
  username: string;
  error?: string;
  onSubmit: (username: string, password: string) => void;
}): JSX.Element {
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  return (
    <div className="login-screen">
      <form
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (user.trim() && password) props.onSubmit(user.trim(), password);
        }}
      >
        <h1>LAN 协作工作台</h1>
        <p className="hint">连接到本部署的中心节点，与局域网内的 Agent 协作</p>
        <input
          autoFocus
          placeholder="用户名"
          value={user}
          onChange={(event) => setUser(event.target.value)}
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" disabled={!user.trim() || !password}>
          登录
        </button>
        {props.error ? <p className="error">{props.error}</p> : null}
      </form>
    </div>
  );
}
