/** Shared due-date helpers, also used by the Inbox and the task modal. */
export function dueChipClass(days) {
  if (days === null || days === undefined) return '';
  if (days < 0) return 'overdue';
  if (days <= 2) return 'due-soon';
  return '';
}

export function dueLabel(dueDate, days) {
  if (!dueDate) return null;
  if (days < 0) return `Overdue ${Math.abs(days)}d`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due ${dueDate}`;
}

/**
 * Display only. Every control lives in the task modal instead - inline selects
 * and buttons could not fit a 300px column without spilling past its edge.
 */
export default function TaskCard({ task, onOpen, onDragStart, onDragEnd, dragging }) {
  const days = task.days_until_due;
  const linkCount = task.links?.length ?? 0;

  return (
    <article
      className={`card p-${task.priority} ${task.is_broadcast ? 'misc' : ''} ${dragging ? 'dragging' : ''}`}
      draggable
      tabIndex={0}
      role="button"
      aria-label={`Open ${task.title}`}
      onClick={() => onOpen(task)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(task);
        }
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(task.id));
        e.dataTransfer.effectAllowed = 'move';
        onDragStart?.(task.id);
      }}
      onDragEnd={() => onDragEnd?.()}
    >
      <div className="card-title">{task.title}</div>

      <div className="card-meta">
        <span className={`chip ${task.priority}`}>{task.priority}</span>
        {task.due_date && (
          <span className={`chip ${dueChipClass(days)}`}>{dueLabel(task.due_date, days)}</span>
        )}
        {task.category && task.category !== 'other' && <span className="chip">{task.category}</span>}
      </div>

      {(task.assigner_name || linkCount > 0 || task.permalink) && (
        <div className="card-foot">
          {task.assigner_name && <span title={`from ${task.assigner_name}`}>{task.assigner_name}</span>}
          <span style={{ flex: 1 }} />
          {linkCount > 0 && <span title={`${linkCount} link(s)`}>🔗 {linkCount}</span>}
          {task.permalink && <span title="From Slack">💬</span>}
        </div>
      )}
    </article>
  );
}
