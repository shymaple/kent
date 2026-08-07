import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import TaskCard from './TaskCard.jsx';
import TaskModal from './TaskModal.jsx';
import Modal from './Modal.jsx';
import TaskForm from './TaskForm.jsx';

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

const sortTasks = (list) =>
  [...list].sort((a, b) => {
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (p !== 0) return p;
    const ad = a.due_date ?? '9999-99-99';
    const bd = b.due_date ?? '9999-99-99';
    return ad === bd ? a.id - b.id : ad < bd ? -1 : 1;
  });

export default function Board({
  refreshKey, onError, settings, onSettings, openTaskId, onOpenedTask, newTaskNonce,
}) {
  const [tasks, setTasks] = useState([]);
  const [lists, setLists] = useState([]);
  const [dragId, setDragId] = useState(null);
  const [overList, setOverList] = useState(null);
  const [openTask, setOpenTask] = useState(null);
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

  function onDrop(listId) {
    setOverList(null);
    if (dragId == null) return;
    const task = tasks.find((t) => t.id === dragId);
    setDragId(null);
    if (!task || task.list_id === listId) return;
    update(dragId, { list_id: listId });
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
    const ordered = [...lists].sort((a, b) => a.position - b.position);
    const i = ordered.findIndex((l) => l.id === list.id);
    const j = i + direction;
    if (j < 0 || j >= ordered.length) return;
    try {
      const [a, b] = [ordered[i], ordered[j]];
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

  // Broadcasts live in the Miscellaneous lane until done, then rejoin the board.
  const boardTasks = tasks.filter((t) => !t.is_broadcast || t.status === 'completed');
  const misc = sortTasks(tasks.filter((t) => t.is_broadcast && t.status !== 'completed'));

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
      </div>

      <div className="board">
        {visibleLists.map((list) => {
          const items = sortTasks(boardTasks.filter((t) => t.list_id === list.id));
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
                  <TaskCard key={t.id} task={t} dragging={dragId === t.id} {...cardProps} />
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
          onClose={() => setOpenTask(null)}
          onSaved={(saved) => {
            setTasks((prev) => prev.map((t) => (t.id === saved.id ? saved : t)));
            setOpenTask(saved);
          }}
          onDeleted={(id) => {
            setTasks((prev) => prev.filter((t) => t.id !== id));
            setOpenTask(null);
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
