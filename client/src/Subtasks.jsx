/**
 * The steps inside a task.
 *
 * A card that is really three actions used to have one checkbox's worth of
 * state, so "mostly done" had nowhere to live except the description, and a
 * card could be dragged to Completed with a step still outstanding. Steps are
 * listed here, ticked here, and the server refuses to complete the task while
 * one is open — this component only has to keep the list honest.
 *
 * Every write answers with the task as well as the steps, because ticking the
 * last one changes the card's counter and unticking one on a finished task
 * moves the card back out of Completed.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

export default function Subtasks({ task, reloadKey = 0, onTask, onError }) {
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(null);   // { id, title } while renaming

  const load = useCallback(async () => {
    try {
      setItems(await api.subtasks(task.id));
    } catch (e) {
      onError(e.message);
    }
  }, [task.id, onError]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  async function run(call) {
    try {
      const { subtasks, task: updated } = await call();
      setItems(subtasks);
      onTask(updated);
    } catch (e) {
      onError(e.message);
      load();
    }
  }

  function add() {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    run(() => api.addSubtask(task.id, title));
  }

  function rename() {
    const { id, title } = editing;
    const next = title.trim();
    setEditing(null);
    if (next && next !== items.find((i) => i.id === id)?.title) {
      run(() => api.updateSubtask(id, { title: next }));
    }
  }

  const done = items.filter((i) => i.done).length;

  return (
    <div className="field">
      <label htmlFor="subtask-new">
        Subtasks{items.length > 0 && ` · ${done} of ${items.length} done`}
      </label>

      {items.length > 0 && (
        <>
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${(done / items.length) * 100}%` }} />
          </div>
          <ul className="subtask-list">
            {items.map((item) => (
              <li key={item.id} className={`subtask ${item.done ? 'done' : ''}`}>
                <input
                  type="checkbox"
                  checked={item.done}
                  aria-label={`${item.done ? 'Reopen' : 'Finish'} ${item.title}`}
                  onChange={(e) => run(() => api.updateSubtask(item.id, { done: e.target.checked }))}
                />
                {editing?.id === item.id ? (
                  <input
                    autoFocus
                    data-own-escape=""
                    value={editing.title}
                    maxLength={200}
                    aria-label="Subtask title"
                    onChange={(e) => setEditing({ id: item.id, title: e.target.value })}
                    onBlur={rename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') rename();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                ) : (
                  <button
                    className="subtask-title"
                    title="Rename"
                    onClick={() => setEditing({ id: item.id, title: item.title })}
                  >
                    {item.title}
                  </button>
                )}
                <button
                  className="tiny"
                  aria-label={`Delete ${item.title}`}
                  title="Delete subtask"
                  onClick={() => run(() => api.deleteSubtask(item.id))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="row">
        <input
          id="subtask-new"
          value={draft}
          maxLength={200}
          placeholder="Add a step, then press Enter"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <button className="small" onClick={add} disabled={!draft.trim()}>Add</button>
      </div>
    </div>
  );
}
