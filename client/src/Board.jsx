import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import TaskCard from './TaskCard.jsx';
import TaskModal from './TaskModal.jsx';
import Modal from './Modal.jsx';
import TaskForm from './TaskForm.jsx';

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

/** Smart order: what needs doing first. */
const smartSort = (list) =>
  [...list].sort((a, b) => {
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (p !== 0) return p;
    const ad = a.due_date ?? '9999-99-99';
    const bd = b.due_date ?? '9999-99-99';
    return ad === bd ? a.id - b.id : ad < bd ? -1 : 1;
  });

/** Manual order: whatever the user dragged it into. */
const manualSort = (list) => [...list].sort((a, b) => a.position - b.position || a.id - b.id);

export default function Board({
  refreshKey, onError, settings, onSettings, openTaskId, onOpenedTask, newTaskNonce,
}) {
  const [tasks, setTasks] = useState([]);
  const [lists, setLists] = useState([]);
  const [dragId, setDragId] = useState(null);
  const [overList, setOverList] = useState(null);
  const [overCard, setOverCard] = useState(null);
  const [openTask, setOpenTask] = useState(null);
  const [autoIntent, setAutoIntent] = useState(null);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [adding, setAdding] = useState(null);       // draft task, or null
  const [renaming, setRenaming] = useState(null);   // list being renamed
  const [renameText, setRenameText] = useState('');
  const [confirmList, setConfirmList] = useState(null);
  const [addingList, setAddingList] = useState(false);
  const [newListName, setNewListName] = useState('');

  const load = useCallback(async () => {
    try {
      const [t, l] = await Promise.all([api.tasks(), api.lists()]);
      setTasks(t);
      setLists(l);
      return t;
    } catch (e) {
      onError(e.message);
      return [];
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Opening a task from search: wait until the board data is in hand.
  useEffect(() => {
    if (!openTaskId) return;
    const found = tasks.find((t) => t.id === openTaskId);
    if (found) {
      setOpenTask(found);
      onOpenedTask?.();
    }
  }, [openTaskId, tasks, onOpenedTask]);

  // ⌘⇧N from anywhere opens the new-task dialog here.
  useEffect(() => {
    if (!newTaskNonce) return;
    setAdding({ priority: 'medium', category: 'other' });
  }, [newTaskNonce]);

  const showCompleted = settings?.show_completed !== 'false';
  const showMisc = settings?.show_miscellaneous !== 'false';
  const manualOrder = settings?.sort_mode === 'manual';
  const ordered = manualOrder ? manualSort : smartSort;

  async function update(id, patch) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    try {
      const updated = await api.updateTask(id, patch);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      setOpenTask((cur) => (cur?.id === id ? updated : cur));
      return updated;
    } catch (e) {
      onError(e.message);
      load();
    }
  }

  /**
   * Drop onto a column. `beforeId` is the card the pointer was over, so a drop
   * inside the same list becomes a reorder rather than a no-op.
   */
  async function onDrop(listId, beforeId = null) {
    setOverList(null);
    setOverCard(null);
    const id = dragId;
    setDragId(null);
    if (id == null) return;

    const task = tasks.find((t) => t.id === id);
    if (!task) return;

    const sameList = task.list_id === listId;
    if (sameList && (beforeId === id || beforeId === null)) return;

    const patch = { list_id: listId };

    // Manual ordering: drop a fractional position between the neighbours, so
    // one card moves without renumbering the column.
    if (manualOrder) {
      const column = ordered(tasks.filter((t) => t.list_id === listId && t.id !== id));
      const index = beforeId ? column.findIndex((t) => t.id === beforeId) : column.length;
      const at = index === -1 ? column.length : index;
      const prev = at > 0 ? column[at - 1].position : null;
      const next = at < column.length ? column[at].position : null;
      patch.position =
        prev == null && next == null ? 1
          : prev == null ? next - 1
            : next == null ? prev + 1
              : (prev + next) / 2;
    }

    const target = lists.find((l) => l.id === listId);
    const updated = await update(id, patch);

    // Finishing a task is the moment to tell whoever asked, so offer the reply
    // right there instead of hoping they remember to open the card.
    if (updated && !sameList && target?.semantic === 'done' && updated.can_reply) {
      setOpenTask(updated);
      setAutoIntent('done');
    }
  }

  async function createTask() {
    const title = adding?.title?.trim();
    if (!title) return;
    try {
      const created = await api.createTask({ ...adding, title });
      setTasks((prev) => [...prev, created]);
      setAdding(null);
    } catch (e) {
      onError(e.message);
    }
  }

  async function addList() {
    const name = newListName.trim();
    if (!name) return setAddingList(false);
    try {
      const created = await api.createList(name);
      setLists((prev) => [...prev, created]);
      setNewListName('');
      setAddingList(false);
    } catch (e) {
      onError(e.message);
    }
  }

  async function renameList(list) {
    const name = renameText.trim();
    setRenaming(null);
    if (!name || name === list.name) return;
    try {
      const updated = await api.updateList(list.id, { name });
      setLists((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
    } catch (e) {
      onError(e.message);
    }
  }

  async function deleteList(list) {
    setConfirmList(null);
    try {
      await api.deleteList(list.id);
      await load();
    } catch (e) {
      onError(e.message);
    }
  }

  async function moveList(list, direction) {
    const byPosition = [...lists].sort((a, b) => a.position - b.position);
    const i = byPosition.findIndex((l) => l.id === list.id);
    const j = i + direction;
    if (j < 0 || j >= byPosition.length) return;
    try {
      const [a, b] = [byPosition[i], byPosition[j]];
      await Promise.all([
        api.updateList(a.id, { position: b.position }),
        api.updateList(b.id, { position: a.position }),
      ]);
      setLists(await api.lists());
    } catch (e) {
      onError(e.message);
    }
  }

  const visibleLists = [...lists]
    .sort((a, b) => a.position - b.position)
    .filter((l) => showCompleted || l.semantic !== 'done');

  // Snoozed cards are out of sight until their date - that is the whole point -
  // but they stay one toggle away so nothing is ever silently lost.
  const visible = showSnoozed ? tasks : tasks.filter((t) => !t.is_snoozed);
  const snoozedCount = tasks.filter((t) => t.is_snoozed).length;

  // Broadcasts live in the Miscellaneous lane until done, then rejoin the board.
  const boardTasks = visible.filter((t) => !t.is_broadcast || t.status === 'completed');
  const misc = ordered(visible.filter((t) => t.is_broadcast && t.status !== 'completed'));

  const cardProps = {
    onOpen: setOpenTask,
    onDragStart: setDragId,
    onDragEnd: () => setDragId(null),
  };

  return (
    <>
      <div className="board-bar">
        <button className="primary" onClick={() => setAdding({ priority: 'medium', category: 'other', list_id: visibleLists[0]?.id })}>
          + Add task
        </button>
        <span className="hint">⌘⇧N</span>
        <div style={{ flex: 1 }} />
        <label className="toggle">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => onSettings({ show_completed: String(e.target.checked) })}
          />
          Completed
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={showMisc}
            onChange={(e) => onSettings({ show_miscellaneous: String(e.target.checked) })}
          />
          Miscellaneous
        </label>

        {snoozedCount > 0 && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={showSnoozed}
              onChange={(e) => setShowSnoozed(e.target.checked)}
            />
            Snoozed ({snoozedCount})
          </label>
        )}

        <select
          value={settings?.sort_mode ?? 'smart'}
          onChange={(e) => onSettings({ sort_mode: e.target.value })}
          style={{ width: 'auto', flex: '0 0 auto' }}
          aria-label="Card order"
          title="Smart orders by priority then due date. Manual lets you drag cards into any order."
        >
          <option value="smart">Smart order</option>
          <option value="manual">Manual order</option>
        </select>
      </div>

      <div className="board">
        {visibleLists.map((list) => {
          const items = ordered(boardTasks.filter((t) => t.list_id === list.id));
          return (
            <section
              key={list.id}
              className={`column ${overList === list.id ? 'drag-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setOverList(list.id);
              }}
              onDragLeave={() => setOverList((c) => (c === list.id ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(list.id);
              }}
            >
              <header className="column-head">
                {renaming === list.id ? (
                  <input
                    autoFocus
                    className="rename"
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onBlur={() => renameList(list)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') renameList(list);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <button
                    className="column-name"
                    title="Rename list"
                    onClick={() => {
                      setRenaming(list.id);
                      setRenameText(list.name);
                    }}
                  >
                    {list.name}
                  </button>
                )}
                <span className="count">{items.length}</span>
                <span className="column-tools">
                  <button className="tiny" title="Move left" onClick={() => moveList(list, -1)}>‹</button>
                  <button className="tiny" title="Move right" onClick={() => moveList(list, 1)}>›</button>
                  <button className="tiny" title="Delete list" onClick={() => setConfirmList(list)}>✕</button>
                </span>
              </header>

              <div className="column-scroll">
                {items.map((t) => (
                  <div
                    key={t.id}
                    className={overCard === t.id ? 'drop-before' : undefined}
                    onDragOver={(e) => {
                      if (!manualOrder) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setOverList(list.id);
                      setOverCard(t.id);
                    }}
                    onDrop={(e) => {
                      if (!manualOrder) return;
                      e.preventDefault();
                      e.stopPropagation();
                      onDrop(list.id, t.id);
                    }}
                  >
                    <TaskCard task={t} dragging={dragId === t.id} {...cardProps} />
                  </div>
                ))}
              </div>

              <button
                className="column-add"
                onClick={() => setAdding({ priority: 'medium', category: 'other', list_id: list.id })}
              >
                + Add
              </button>
            </section>
          );
        })}

        <div className="column add-list">
          {addingList ? (
            <input
              autoFocus
              value={newListName}
              placeholder="List name"
              onChange={(e) => setNewListName(e.target.value)}
              onBlur={addList}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addList();
                if (e.key === 'Escape') setAddingList(false);
              }}
            />
          ) : (
            <button className="ghost" onClick={() => setAddingList(true)}>
              + Add list
            </button>
          )}
        </div>
      </div>

      {showMisc && misc.length > 0 && (
        <section className="misc-lane">
          <header className="column-head">
            <span>Miscellaneous · channel-wide asks</span>
            <span className="count">{misc.length}</span>
          </header>
          <div className="misc-grid">
            {misc.map((t) => (
              <TaskCard key={t.id} task={t} dragging={dragId === t.id} {...cardProps} />
            ))}
          </div>
        </section>
      )}

      {tasks.length === 0 && (
        <p className="empty">
          No tasks yet. Hit <strong>Sync now</strong> to pull from Slack, then approve items in the Inbox.
        </p>
      )}

      {openTask && (
        <TaskModal
          task={openTask}
          lists={lists}
          templates={settings?.comment_templates ?? []}
          autoIntent={autoIntent}
          onClose={() => {
            setOpenTask(null);
            setAutoIntent(null);
          }}
          onSaved={(saved) => {
            setTasks((prev) => prev.map((t) => (t.id === saved.id ? saved : t)));
            setOpenTask(saved);
          }}
          onDeleted={(id) => {
            setTasks((prev) => prev.filter((t) => t.id !== id));
            setOpenTask(null);
            setAutoIntent(null);
          }}
          onError={onError}
        />
      )}

      {adding && (
        <Modal onClose={() => setAdding(null)} labelledBy="add-task-title">
          <header className="modal-head">
            <h2 id="add-task-title">New task</h2>
            <button className="ghost" onClick={() => setAdding(null)} aria-label="Close">✕</button>
          </header>
          <div className="modal-body single">
            <TaskForm value={adding} onChange={setAdding} lists={lists} autoFocus />
            <div className="row end">
              <button className="ghost" onClick={() => setAdding(null)}>Cancel</button>
              <button className="primary" onClick={createTask} disabled={!adding.title?.trim()}>
                Add task
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirmList && (
        <Modal onClose={() => setConfirmList(null)} labelledBy="confirm-list-title">
          <header className="modal-head">
            <h2 id="confirm-list-title">Delete “{confirmList.name}”?</h2>
          </header>
          <div className="modal-body single">
            <p>
              Its {tasks.filter((t) => t.list_id === confirmList.id).length} task(s) move to{' '}
              <strong>{visibleLists.find((l) => l.id !== confirmList.id)?.name ?? 'the first list'}</strong>.
              No task is deleted.
            </p>
            <div className="row end">
              <button className="ghost" onClick={() => setConfirmList(null)}>Cancel</button>
              <button className="danger" onClick={() => deleteList(confirmList)}>Delete list</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
