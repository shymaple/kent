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
export default function TaskCard({ task, onOpen, lifted = false }) {
  const days = task.days_until_due;
  const linkCount = task.links?.length ?? 0;

  return (
    <article
      className={`card p-${task.priority} ${task.is_broadcast ? 'misc' : ''} ${lifted ? 'lifted' : ''}`}
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
    >
      <div className="card-title">{task.title}</div>

      <div className="card-meta">
        <span className={`chip ${task.priority}`}>{task.priority}</span>
        {task.due_date && (
          <span className={`chip ${dueChipClass(days)}`}>{dueLabel(task.due_date, days)}</span>
        )}
        {/* Without a lane header, the tint needs a label to mean anything. */}
        {task.is_broadcast && (
          <span className="chip" title="Sent to the whole channel, not to you personally">
            channel-wide
          </span>
        )}
        {task.category && task.category !== 'other' && task.category !== 'broadcast' && (
          <span className="chip">{task.category}</span>
        )}
        {task.stale_days != null && (
          <span className="chip medium" title="Untouched while in progress">
            idle {task.stale_days}d
          </span>
        )}
        {task.is_snoozed && (
          <span className="chip" title={`Hidden until ${task.snooze_until}`}>
            💤 {task.snooze_until}
          </span>
        )}
      </div>

      {(task.assigner_name || linkCount > 0 || task.permalink || task.comment_count > 0) && (
        <div className="card-foot">
          {task.assigner_name && <span title={`from ${task.assigner_name}`}>{task.assigner_name}</span>}
          <span style={{ flex: 1 }} />
          {/* Whether the person who asked has been told is the thing you most
              want to see without opening the card. */}
          {task.replied_in_slack ? (
            <span className="replied" title="You replied in the Slack thread">✓ replied</span>
          ) : (
            task.comment_count > 0 && <span title={`${task.comment_count} comment(s)`}>💬 {task.comment_count}</span>
          )}
          {linkCount > 0 && <span title={`${linkCount} link(s)`}>🔗 {linkCount}</span>}
          {task.permalink && <span title="From Slack">↗</span>}
        </div>
      )}
    </article>
  );
}
