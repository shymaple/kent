import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import Modal from './Modal.jsx';
import TaskForm from './TaskForm.jsx';
import { dueChipClass, dueLabel } from './TaskCard.jsx';

const INTENTS = [
  { key: 'done', label: 'Done' },
  { key: 'progress', label: 'Progress update' },
  { key: 'blocked', label: 'Blocked' },
];

export default function TaskModal({ task, lists, templates = [], onClose, onSaved, onDeleted, onError }) {
  const [draft, setDraft] = useState(() => ({ ...task }));
  const [dirty, setDirty] = useState(false);
  const [comments, setComments] = useState([]);
  const [composer, setComposer] = useState('');
  const [variants, setVariants] = useState([]);
  const [drafting, setDrafting] = useState(false);
  const [sendingId, setSendingId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  function edit(next) {
    setDraft(next);
    setDirty(true);
  }

  async function save() {
    try {
      const saved = await api.updateTask(task.id, {
        title: draft.title,
        description: draft.description,
        priority: draft.priority,
        due_date: draft.due_date || null,
        category: draft.category,
        list_id: draft.list_id,
      });
      setDirty(false);
      onSaved(saved);
    } catch (e) {
      onError(e.message);
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

  async function remove() {
    try {
      await api.deleteTask(task.id);
      onDeleted(task.id);
    } catch (e) {
      onError(e.message);
    }
  }

  const canReply = Boolean(task.channel_id && (task.thread_ts || task.message_ts));

  return (
    <Modal onClose={onClose} labelledBy="task-modal-title" wide>
      <header className="modal-head">
        <h2 id="task-modal-title">{draft.title || 'Task'}</h2>
        <button className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="modal-body">
        <section className="modal-main">
          <TaskForm value={draft} onChange={edit} lists={lists} />

          {task.source_text && (
            <div className="field">
              <label>Original Slack message</label>
              <div className="source-quote">{task.source_text}</div>
            </div>
          )}

          <div className="card-meta" style={{ marginBottom: 14 }}>
            {task.due_date && (
              <span className={`chip ${dueChipClass(task.days_until_due)}`}>
                {dueLabel(task.due_date, task.days_until_due)}
              </span>
            )}
            {task.assigner_name && <span className="chip">from {task.assigner_name}</span>}
            {task.channel_name && <span className="chip">{task.channel_name}</span>}
            {task.permalink && (
              <a className="chip" href={task.permalink} target="_blank" rel="noreferrer">
                ↗ Open in Slack
              </a>
            )}
            {task.links?.map((l) => (
              <a className="chip" key={l.url} href={l.url} target="_blank" rel="noreferrer">
                ↗ {l.label}
              </a>
            ))}
          </div>

          <div className="row">
            {confirmDelete ? (
              <>
                <span className="chip high">Delete this task?</span>
                <button className="danger" onClick={remove}>
                  Yes, delete
                </button>
                <button className="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="ghost" onClick={() => setConfirmDelete(true)}>
                Delete task
              </button>
            )}
            <div style={{ flex: 1 }} />
            {dirty && <span className="chip medium">Unsaved changes</span>}
            <button className="primary" onClick={save} disabled={!dirty}>
              Save
            </button>
          </div>
        </section>

        <aside className="modal-side">
          <h3>Activity</h3>

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
