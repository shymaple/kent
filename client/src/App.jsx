import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import Board from './Board.jsx';
import Inbox from './Inbox.jsx';
import Settings from './Settings.jsx';
import CommandBar from './CommandBar.jsx';

/** True when focus is in a field, so single-key shortcuts stay out of the way. */
function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

export default function App() {
  const [tab, setTab] = useState('board');
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [openTaskId, setOpenTaskId] = useState(null);
  const [newTaskNonce, setNewTaskNonce] = useState(0);

  const lastSeenRun = useRef(null);

  const loadStatus = useCallback(async () => {
    try {
      const next = await api.syncStatus();
      setStatus(next);

      // A background sync finished since we last looked, so what's on screen is
      // stale. Reload it rather than waiting for the user to press Sync now -
      // the point of auto-sync is that they shouldn't have to. Tracked in a ref
      // so this stays a plain side effect, not one hidden in a state updater.
      const run = next.last_run;
      if (run?.finished_at && run.id !== lastSeenRun.current) {
        const first = lastSeenRun.current === null;
        lastSeenRun.current = run.id;
        if (!first && run.inboxed > 0) setRefreshKey((k) => k + 1);
      }
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api.settings());
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadSettings();
    // Polls our own local server, not Slack and not the model.
    const t = setInterval(loadStatus, 15_000);
    // Coming back to the tab is the moment a stale board is most obvious.
    const onFocus = () => loadStatus();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadStatus, loadSettings, refreshKey]);

  useEffect(() => {
    if (status && !status.connected) setTab('settings');
  }, [status?.connected]);

  /** Persist a settings patch and keep local state in step. */
  const patchSettings = useCallback(async (patch) => {
    setSettings((s) => ({ ...s, ...patch }));
    try {
      await api.saveSettings(patch);
    } catch (e) {
      setError(e.message);
      loadSettings();
    }
  }, [loadSettings]);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await api.runSync();
      if (result.skipped) {
        setError(
          result.reason === 'no_token' ? 'Connect Slack in Settings first.' : 'A sync is already running.'
        );
      }
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
      loadStatus();
    }
  }, [loadStatus]);

  // Global shortcuts. Cmd+Space and Cmd+N never reach a web page - Spotlight and
  // the browser take them first - so search is Cmd+K and new task is Cmd+Shift+N.
  useEffect(() => {
    function onKeyDown(e) {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setTab('board');
        setNewTaskNonce((n) => n + 1);
        return;
      }
      if (e.key === '/' && !mod && !isTyping()) {
        e.preventDefault();
        setSearchOpen(true);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const lastRun = status?.last_run;
  const pending = status?.inbox_pending ?? 0;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            Kent<span>Slack → Kanban</span>
          </div>
          <nav className="tabs">
            <button className={`tab ${tab === 'board' ? 'active' : ''}`} onClick={() => setTab('board')}>
              Board
            </button>
            <button className={`tab ${tab === 'inbox' ? 'active' : ''}`} onClick={() => setTab('inbox')}>
              Inbox
              {pending > 0 && <span className="badge">{pending}</span>}
            </button>
            <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
              Settings
            </button>
          </nav>

          <button className="search-trigger" onClick={() => setSearchOpen(true)}>
            Search<kbd>⌘K</kbd>
          </button>

          <div style={{ flex: 1 }} />

          <span className={`status-note ${error ? 'err' : ''}`}>
            {error ??
              (syncing || status?.running
                ? 'Syncing…'
                : lastRun?.finished_at
                  ? `Last sync ${formatWhen(lastRun.finished_at)} · ${lastRun.messages_seen} msgs · ${lastRun.llm_calls} LLM call${lastRun.llm_calls === 1 ? '' : 's'}`
                  : 'Never synced')}
          </span>
          <button className="primary" onClick={syncNow} disabled={syncing || status?.running}>
            Sync now
          </button>
        </div>
      </header>

      <main className={tab === 'board' ? 'board-main' : ''}>
        {tab === 'board' && (
          <Board
            refreshKey={refreshKey}
            onError={setError}
            settings={settings}
            onSettings={patchSettings}
            openTaskId={openTaskId}
            onOpenedTask={() => setOpenTaskId(null)}
            newTaskNonce={newTaskNonce}
          />
        )}
        {tab === 'inbox' && (
          <Inbox
            refreshKey={refreshKey}
            onError={setError}
            onChange={() => setRefreshKey((k) => k + 1)}
          />
        )}
        {tab === 'settings' && (
          <Settings
            onError={setError}
            onChange={() => {
              setRefreshKey((k) => k + 1);
              loadSettings();
            }}
          />
        )}
      </main>

      {searchOpen && (
        <CommandBar
          onClose={() => setSearchOpen(false)}
          onError={setError}
          onPick={(task) => {
            setSearchOpen(false);
            setTab('board');
            setOpenTaskId(task.id);
          }}
        />
      )}
    </>
  );
}

/** SQLite hands us "YYYY-MM-DD HH:MM:SS" in UTC. */
function formatWhen(sqliteUtc) {
  const d = new Date(`${sqliteUtc.replace(' ', 'T')}Z`);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString();
}
