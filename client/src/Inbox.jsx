import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { dueChipClass, dueLabel, sentFull, sentShort } from './TaskCard.jsx';

const CATEGORIES = ['bug', 'review', 'meeting', 'admin', 'doc', 'followup', 'other'];

const REASON_LABEL = {
  mention: 'mentioned you',
  self: 'you tagged yourself',
  priority_person: 'from a priority person',
  dm: 'direct message',
  group_dm: 'group DM',
  thread_reply: 'thread reply',
  broadcast: 'channel-wide',
  alias: 'used your name',
  email_to: 'emailed you',
  email_cc: 'named you in an email',
};

/** Plain-language explanation of a queue that isn't moving. */
function WaitingBanner({ waiting }) {
  if (!waiting?.waiting) return null;
  return (
    <div className="banner">
      <strong>{waiting.waiting} message{waiting.waiting === 1 ? '' : 's'} waiting to be judged.</strong>{' '}
      They were captured from Slack and are safe on disk — Claude just hasn't looked at them yet.
      They'll appear here on the next sync that reaches it.
      {waiting.last_error && <> Last attempt said: “{waiting.last_error}”</>}
    </div>
  );
}

export default function Inbox({ refreshKey, waiting, onError, onChange }) {
  const [items, setItems] = useState([]);
  const [editing, setEditing] = useState(null); // id being edited
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.inbox());
    } catch (e) {
      onError(e.message);
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  function startEdit(item) {
    setEditing(item.id);
    setDraft({
      title: item.title,
      description: item.description ?? '',
      priority: item.priority,
      due_date: item.due_date ?? '',
      category: CATEGORIES.includes(item.category) ? item.category : 'other',
    });
  }

  async function approve(item, edits) {
    setBusy(item.id);
    try {
      await api.approve(item.id, edits ?? {});
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setEditing(null);
      onChange();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(item) {
    setBusy(item.id);
    try {
      await api.dismiss(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      onChange();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return (
      <>
        <WaitingBanner waiting={waiting} />
        <p className="empty">Inbox is clear. New Slack asks land here after a sync.</p>
      </>
    );
  }

  return (
    <>
      <WaitingBanner waiting={waiting} />
      <div className="banner">
        {items.length} item{items.length === 1 ? '' : 's'} to triage. Approving puts a card on your
        board; dismissing hides that message for good.
      </div>

      <div className="inbox-list">
        {items.map((item) => {
          const isEditing = editing === item.id;
          return (
            <article
              key={item.id}
              className={`inbox-item p-${item.priority} ${item.is_broadcast ? 'misc' : ''}`}
            >
              {/* A new ask in a thread that already has a card: approving adds a
                  step to that card rather than a second card for the same work. */}
              {item.parent_task_id && (
                <div className="followup">
                  ↳ Follow-up in a thread you're already tracking — approving adds this as a
                  subtask of <strong>{item.parent_task_title}</strong>.
                </div>
              )}

              {isEditing ? (
                <>
                  <div className="field">
                    <label htmlFor={`inbox-title-${item.id}`}>Title</label>
                    <input
                      id={`inbox-title-${item.id}`}
                      autoFocus
                      maxLength={120}
                      value={draft.title}
                      onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Description</label>
                    <textarea
                      value={draft.description}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    />
                  </div>
                  <div className="edit-grid">
                    <div>
                      <label>Priority</label>
                      <select
                        value={draft.priority}
                        onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
                      >
                        <option value="high">high</option>
                        <option value="medium">medium</option>
                        <option value="low">low</option>
                      </select>
                    </div>
                    <div>
                      <label>Due date</label>
                      <input
                        type="date"
                        value={draft.due_date}
                        onChange={(e) => setDraft({ ...draft, due_date: e.target.value })}
                      />
                    </div>
                    <div>
                      <label>Category</label>
                      <select
                        value={draft.category}
                        onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                      >
                        {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="card-title">{item.title}</div>
                  {item.description && <div className="card-desc">{item.description}</div>}
                </>
              )}

              <div className="card-meta">
                <span className={`chip ${item.priority}`}>{item.priority}</span>
                {item.due_date && (
                  <span className={`chip ${dueChipClass(item.days_until_due)}`}>
                    {dueLabel(item.due_date, item.days_until_due)}
                  </span>
                )}
                {item.category && <span className="chip">{item.category}</span>}
                <span className="chip">
                  {item.assigner_name ?? 'someone'} · {REASON_LABEL[item.reason] ?? item.reason}
                </span>
                <span className="chip">{item.channel_name}</span>
                {sentShort(item.sent_at) && (
                  <span className="chip" title={sentFull(item.sent_at, item.sent_at_source)}>
                    🕒 {sentShort(item.sent_at)}
                  </span>
                )}
                {item.permalink && (
                  <a className="chip" href={item.permalink} target="_blank" rel="noreferrer">
                    ↗ {item.source === 'email' ? 'Email' : 'Slack'}
                  </a>
                )}
                {item.links?.map((l) => (
                  <a className="chip" key={l.url} href={l.url} target="_blank" rel="noreferrer">
                    ↗ {l.label}
                  </a>
                ))}
                {item.confidence < 0.5 && <span className="chip medium">low confidence</span>}
              </div>

              <div className="source-quote">{item.source_text}</div>

              <div className="row end">
                {isEditing ? (
                  <>
                    <button className="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button
                      className="primary"
                      disabled={busy === item.id || !draft.title.trim()}
                      onClick={() => approve(item, { ...draft, due_date: draft.due_date || null })}
                    >
                      Save & approve
                    </button>
                  </>
                ) : (
                  <>
                    <button className="ghost" disabled={busy === item.id} onClick={() => dismiss(item)}>
                      Dismiss
                    </button>
                    <button onClick={() => startEdit(item)}>Edit</button>
                    <button className="primary" disabled={busy === item.id} onClick={() => approve(item)}>
                      {item.parent_task_id ? 'Add as subtask' : 'Approve'}
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
