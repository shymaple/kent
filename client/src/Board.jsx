import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor,
  closestCorners, useSensor, useSensors,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { api } from './api.js';
import TaskCard from './TaskCard.jsx';
import TaskModal from './TaskModal.jsx';
import Modal from './Modal.jsx';
import TaskForm from './TaskForm.jsx';
import { SortableCard, DroppableColumn } from './Sortable.jsx';

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
  // While a drag is in flight this holds the live arrangement { listId: [id,…] }.
  // Rendering from it, rather than re-sorting on every pointer move, is what
  // keeps the gap steady under the cursor instead of flickering between slots.
  const [dragBoard, setDragBoard] = useState(null);
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

  /* ------------------------------------------------------------ dragging */

  const sensors = useSensors(
    // A few pixels of travel before a drag begins, so a plain click still opens
    // the card instead of being swallowed as a tiny drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  /** Which column an id belongs to, whether it's a card or the column itself. */
  function columnOf(id, board) {
    if (typeof id === 'string' && id.startsWith('list-')) return Number(id.slice(5));
    return Number(Object.keys(board).find((listId) => board[listId].includes(id)));
  }

  function onDragStart({ active }) {
    setDragId(active.id);
    // Snapshot what's on screen, so the arrangement during the drag is the one
    // the user is looking at rather than a re-derived sort.
    const snapshot = {};
    for (const list of visibleLists) {
      snapshot[list.id] = ordered(boardTasks.filter((t) => t.list_id === list.id)).map((t) => t.id);
    }
    setDragBoard(snapshot);
  }

  function onDragOver({ active, over }) {
    if (!over || !dragBoard) return;
    const from = columnOf(active.id, dragBoard);
    const to = columnOf(over.id, dragBoard);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;

    // Crossing into another column: open the gap there straight away.
    setDragBoard((board) => {
      const target = board[to] ?? [];
      const overIndex = target.indexOf(over.id);
      const insertAt = overIndex === -1 ? target.length : overIndex;
      return {
        ...board,
        [from]: board[from].filter((id) => id !== active.id),
        [to]: [...target.slice(0, insertAt), active.id, ...target.slice(insertAt)],
      };
    });
  }

  function onDragCancel() {
    setDragId(null);
    setDragBoard(null);
  }

  async function onDragEnd({ active, over }) {
    const board = dragBoard;
    setDragId(null);
    setDragBoard(null);
    if (!board || !over) return;

    const task = tasks.find((t) => t.id === active.id);
    const to = columnOf(over.id, board);
    if (!task || !Number.isFinite(to)) return;

    // Settle the final slot within the destination column.
    const column = board[to] ?? [];
    const fromIndex = column.indexOf(active.id);
    const overIndex = column.indexOf(over.id);
    const finalOrder =
      fromIndex !== -1 && overIndex !== -1 && fromIndex !== overIndex
        ? arrayMove(column, fromIndex, overIndex)
        : column;

    const movedList = task.list_id !== to;
    const sameOrder =
      !movedList &&
      finalOrder.join() === ordered(boardTasks.filter((t) => t.list_id === to)).map((t) => t.id).join();
    if (sameOrder) return;

    // Paint the result immediately; the server is only catching up.
    const rank = new Map(finalOrder.map((id, i) => [id, i + 1]));
    setTasks((prev) =>
      prev.map((t) => (rank.has(t.id) ? { ...t, list_id: to, position: rank.get(t.id) } : t))
    );

    try {
      if (movedList) await api.updateTask(active.id, { list_id: to });
      await api.reorderList(to, finalOrder);
      // Source column closes its gap too, so its numbering stays contiguous.
      if (movedList && board[task.list_id]?.length) {
        await api.reorderList(task.list_id, board[task.list_id]);
      }
      if (!manualOrder) await onSettings({ sort_mode: 'manual' });
    } catch (e) {
      onError(e.message);
      load();
      return;
    }

    const target = lists.find((l) => l.id === to);
    if (movedList && target?.semantic === 'done') {
      // Finishing a task is the moment to tell whoever asked, so offer the reply
      // right there instead of hoping they remember to open the card.
      const fresh = (await load()).find((t) => t.id === active.id);
      if (fresh?.can_reply) {
        setOpenTask(fresh);
        setAutoIntent('done');
      }
    } else {
      load();
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

  // Channel-wide asks sit in the normal columns and behave like any other card.
  // They are forced to low priority when captured, so smart order already sinks
  // them below real work - a separate lane was never doing anything the colour
  // and the priority weren't. The toggle now just filters them out entirely.
  const boardTasks = showMisc ? visible : visible.filter((t) => !t.is_broadcast);

  const byId = useMemo(() => new Map(boardTasks.map((t) => [t.id, t])), [boardTasks]);

  /**
   * A column's cards. Mid-drag this follows the live arrangement, so the gap
   * stays where the user put it; otherwise it's the normal sort.
   */
  function columnItems(listId) {
    if (dragBoard?.[listId]) return dragBoard[listId].map((id) => byId.get(id)).filter(Boolean);
    return ordered(boardTasks.filter((t) => t.list_id === listId));
  }

  const draggedTask = dragId != null ? byId.get(dragId) : null;
  const overListId = dragBoard ? columnOf(dragId, dragBoard) : null;

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
          Channel-wide
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
          title="Smart orders by priority then due date. Dragging a card into place switches to your own order."
        >
          <option value="smart">Smart order</option>
          <option value="manual">My order</option>
        </select>
        {manualOrder && (
          <button
            className="ghost small"
            title="Go back to ordering by priority, then due date"
            onClick={() => onSettings({ sort_mode: 'smart' })}
          >
            Reset order
          </button>
        )}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
      <div className="board">
        {visibleLists.map((list) => {
          const items = columnItems(list.id);
          return (
            <DroppableColumn key={list.id} list={list} isOver={dragId != null && overListId === list.id}>
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
                <SortableContext items={items.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                  {items.map((t) => (
                    <SortableCard key={t.id} task={t} onOpen={setOpenTask} />
                  ))}
                </SortableContext>
              </div>

              <button
                className="column-add"
                onClick={() => setAdding({ priority: 'medium', category: 'other', list_id: list.id })}
              >
                + Add
              </button>
            </DroppableColumn>
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

      {/* The card under the cursor, rendered above everything so it can leave
          its column without being clipped by the column's own scroll box. */}
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
        {draggedTask ? <TaskCard task={draggedTask} onOpen={() => {}} lifted /> : null}
      </DragOverlay>
      </DndContext>

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
