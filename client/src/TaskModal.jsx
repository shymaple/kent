import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import Modal from './Modal.jsx';
import TaskFields from './TaskFields.jsx';
import { dueChipClass, dueLabel } from './TaskCard.jsx';

const INTENTS = [
  { key: 'done', label: 'Done' },
  { key: 'progress', label: 'Progress update' },
  { key: 'blocked', label: 'Blocked' },
];

/** Keeps header items to a length the row can actually fit. */
const truncate = (text, max) => {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
};

export default function TaskModal({
  task, templates = [], autoIntent, onClose, onSaved, onDeleted, onError,
}) {
  const [comments, setComments] = useState([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  // The title is the one field held locally while typing, so each keystroke
  // isn't a write; it commits on blur, Enter, or reverts on Escape.
  const [title, setTitle] = useState(task.title);
  const [composer, setComposer] = useState('');
  const [variants, setVariants] = useState([]);
  const [drafting, setDrafting] = useState(false);
  const [sendingId, setSendingId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Declared before the effects that read it, not after.
  const canReply = Boolean(task.channel_id && (task.thread_ts || task.message_ts));

  const loadComments = useCallback(async () => {
    try {
      setComments(await api.comments(task.id));
    } catch (e) {
      onError(e.message);
    }
  }, [task.id, onError]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  // Opened by finishing a task: draft the reply straight away, so the only thing
  // left to do is read it and press Send. Never sends on its own.
  const drafted = useRef(false);
  useEffect(() => {
    if (!autoIntent || drafted.current || !canReply) return;
    drafted.current = true;
    generate(autoIntent);
  }, [autoIntent]);

  /**
   * Every field writes as soon as it is left, so there is no Save button and no
   * way to lose an edit by closing the dialog.
   */
  async function commit(patch) {
    setSaving(true);
    try {
      const saved = await api.updateTask(task.id, patch);
      onSaved(saved);
      setSavedAt(Date.now());
    } catch (e) {
      onError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function generate(intent) {
    setDrafting(true);
    setVariants([]);
    try {
      const { variants: v } = await api.draftComment(task.id, intent);
      setVariants(v);
    } catch (e) {
      onError(e.message);
    } finally {
      setDrafting(false);
    }
  }

  async function addComment(kind = 'manual') {
    const body = composer.trim();
    if (!body) return;
    try {
      const created = await api.addComment(task.id, body, kind);
      setComments((prev) => [...prev, created]);
      setComposer('');
      setVariants([]);
      return created;
    } catch (e) {
      onError(e.message);
    }
  }

  /** Explicit two-step: the text is on screen before anything reaches Slack. */
  async function sendToSlack(comment) {
    setSendingId(comment.id);
    try {
      const sent = await api.sendComment(comment.id);
      setComments((prev) => prev.map((c) => (c.id === sent.id ? sent : c)));
    } catch (e) {
      onError(e.message);
    } finally {
      setSendingId(null);
    }
  }

  async function saveAndSend() {
    const created = await addComment();
    if (created) await sendToSlack(created);
  }

  const snoozeUntil = (date) => commit({ snooze_until: date });

  function snooze(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    snoozeUntil(d.toISOString().slice(0, 10));
  }

  async function remove() {
    try {
      await api.deleteTask(task.id);
      onDeleted(task.id);
    } catch (e) {
      onError(e.message);
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="task-modal-title" wide>
      {/* Title takes half the header; who it came from and where it lives fill
          the rest, each truncated so the row can never wrap or push the close
          button off the edge. */}
      <header className="modal-head task-head">
        <input
          id="task-modal-title"
          className="title-input"
          value={title}
          maxLength={120}
          placeholder="Task title"
          aria-label="Task title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            const next = title.trim();
            if (!next) return setTitle(task.title);
            if (next !== task.title) commit({ title: next });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setTitle(task.title);
              e.currentTarget.blur();
            }
          }}
        />

        {/* Slack sits last, nearest the close button: it is the thing reached
            for most often, so it gets the shortest travel. */}
        <div className="head-meta">
          {task.assigner_name && (
            <span className="head-tag" title={`Asked by ${task.assigner_name}`}>
              from <strong>{truncate(task.assigner_name, 22)}</strong>
            </span>
          )}
          {task.channel_name && (
            <span className="head-tag" title={task.channel_name}>
              {truncate(task.channel_name, 24)}
            </span>
          )}
          {task.permalink && (
            <a className="head-tag link" href={task.permalink} target="_blank" rel="noreferrer">
              ↗ Slack
            </a>
          )}
        </div>

        <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
      </header>

      <div className="modal-body">
        <section className="modal-main">
          <TaskFields task={task} onCommit={commit} />

          {task.source_text && (
            <div className="field">
              <label>Original Slack message</label>
              <div className="source-quote">{task.source_text}</div>
            </div>
          )}

          {task.links?.length > 0 && (
            <div className="field">
              <label>Attachments and links</label>
              <div className="link-list">
                {task.links.map((l) => (
                  <a className="link" key={l.url} href={l.url} target="_blank" rel="noreferrer" title={l.url}>
                    ↗ {truncate(l.label, 46)}
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="field">
            <label>Snooze — hide until</label>
            <div className="row">
              <button className="small" onClick={() => snooze(1)}>Tomorrow</button>
              <button className="small" onClick={() => snooze(7)}>Next week</button>
              <input
                type="date"
                value={task.snooze_until ?? ''}
                onChange={(e) => snoozeUntil(e.target.value || null)}
                style={{ width: 'auto' }}
                aria-label="Snooze until"
              />
              {task.snooze_until && (
                <button className="ghost small" onClick={() => snoozeUntil(null)}>Unsnooze</button>
              )}
            </div>
            {task.is_snoozed && (
              <p className="hint" style={{ marginTop: 6 }}>
                Hidden from the board until {task.snooze_until}.
              </p>
            )}
          </div>

          <div className="row">
            {confirmDelete ? (
              <>
                <span className="chip high">Delete this task?</span>
                <button className="danger" onClick={remove}>Yes, delete</button>
                <button className="ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
              </>
            ) : (
              <button className="ghost" onClick={() => setConfirmDelete(true)}>Delete task</button>
            )}
            <div style={{ flex: 1 }} />
            <span className="save-state">
              {saving ? 'Saving…' : savedAt ? 'Saved' : 'Changes save as you go'}
            </span>
          </div>
        </section>

        <aside className="modal-side">
          <h3>Activity</h3>

          {autoIntent === 'done' && (
            <div className="banner" style={{ marginBottom: 12 }}>
              {canReply
                ? <>Task done — here's a reply for <strong>{task.assigner_name ?? 'the thread'}</strong>. Nothing is sent until you press Send.</>
                : <>Task done. This one didn't come from Slack, so there's no thread to reply to.</>}
            </div>
          )}

          {comments.length === 0 && <p className="hint">No comments yet.</p>}

          <ol className="comment-list">
            {comments.map((c) => (
              <li key={c.id} className="comment">
                <div className="comment-body">{c.body}</div>
                <div className="comment-meta">
                  <span>{new Date(`${c.created_at.replace(' ', 'T')}Z`).toLocaleString()}</span>
                  {c.slack_ts ? (
                    <a className="chip low" href={c.permalink ?? task.permalink} target="_blank" rel="noreferrer">
                      ✓ replied in Slack
                    </a>
                  ) : canReply ? (
                    <button
                      className="small"
                      disabled={sendingId === c.id}
                      onClick={() => sendToSlack(c)}
                    >
                      {sendingId === c.id ? 'Sending…' : 'Send to Slack'}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>

          <div className="composer">
            <div className="row" style={{ marginBottom: 8 }}>
              {INTENTS.map((i) => (
                <button key={i.key} className="small" disabled={drafting} onClick={() => generate(i.key)}>
                  {drafting ? '…' : i.label}
                </button>
              ))}
            </div>

            {variants.length > 0 && (
              <ul className="variants">
                {variants.map((v, i) => (
                  <li key={i}>
                    <button className="variant" onClick={() => setComposer(v)}>
                      {v}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {templates.length > 0 && (
              <div className="row" style={{ marginBottom: 8 }}>
                {templates.map((t) => (
                  <button key={t} className="small ghost" onClick={() => setComposer(t)}>
                    {t}
                  </button>
                ))}
              </div>
            )}

            <textarea
              value={composer}
              placeholder={canReply ? 'Write a comment, or generate one above…' : 'Write a comment…'}
              onChange={(e) => setComposer(e.target.value)}
            />

            <div className="row end" style={{ marginTop: 8 }}>
              <button onClick={() => addComment()} disabled={!composer.trim()}>
                Log only
              </button>
              {canReply && (
                <button className="primary" onClick={saveAndSend} disabled={!composer.trim()}>
                  Send to Slack
                </button>
              )}
            </div>
            {!canReply && (
              <p className="hint" style={{ marginTop: 6 }}>
                This task didn't come from Slack, so there's no thread to reply to.
              </p>
            )}
          </div>
        </aside>
      </div>
    </Modal>
  );
}
