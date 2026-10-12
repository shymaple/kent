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
 * When the ask arrived. Short form for a card ("11 Aug, 3:42 pm"), with the
 * year only when it isn't this one, so the common case stays narrow.
 */
export function sentShort(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Full form for tooltips and the modal header. */
export function sentFull(iso, source) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const how = source === 'slack' ? 'Sent in Slack' : source === 'email' ? 'Emailed' : 'Added';
  return `${how} ${d.toLocaleString()}`;
}

/**
 * Display only. Every control lives in the task modal instead - inline selects
 * and buttons could not fit a 300px column without spilling past its edge.
 */
export default function TaskCard({ task, onOpen, onComplete, lifted = false, focusable = true }) {
  const days = task.days_until_due;
  const linkCount = task.links?.length ?? 0;
  const fileCount = task.attachments?.length ?? 0;
  const sent = sentShort(task.sent_at);

  return (
    <article
      className={`card p-${task.priority} ${task.is_broadcast ? 'misc' : ''} ${lifted ? 'lifted' : ''} ${task.is_done ? 'done' : ''}`}
      // On the board the sortable wrapper is the tab stop; a second one here
      // made every card take two presses of Tab to get past.
      tabIndex={focusable ? 0 : undefined}
      role={focusable ? 'button' : undefined}
      aria-label={focusable ? `Open ${task.title}` : undefined}
      onClick={() => onOpen(task)}
      onKeyDown={(e) => {
        if (focusable && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen(task);
        }
      }}
    >
      <div className="card-top">
        {/* The one control allowed on a card: finishing is the commonest thing
            done to a task, and it shouldn't need a dialog or a drag. */}
        {onComplete && !task.is_done && (
          <button
            className="card-check"
            aria-label={`Mark ${task.title} done`}
            title="Mark done"
            onClick={(e) => {
              e.stopPropagation();
              onComplete(task);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
        )}
        <div className="card-title">{task.title}</div>
      </div>

      <div className="card-meta">
        <span className={`chip ${task.priority}`}>{task.priority}</span>
        {task.due_date && (
          <span className={`chip ${dueChipClass(days)}`}>{dueLabel(task.due_date, days)}</span>
        )}
        {/* Without a lane header, the tint needs a label to mean anything. */}
        {task.is_broadcast && (
          <span className="chip" title="Sent to a whole channel or a long list of people, not to you personally">
            {task.source === 'email' ? 'sent to many' : 'channel-wide'}
          </span>
        )}
        {task.category && task.category !== 'other' && task.category !== 'broadcast' && (
          <span className="chip">{task.category}</span>
        )}
        {task.subtask_count > 0 && (
          <span
            className={`chip ${task.subtasks_open ? '' : 'low'}`}
            title={task.subtasks_open ? `${task.subtasks_open} subtask(s) still open` : 'All subtasks done'}
          >
            ☑ {task.subtask_count - task.subtasks_open}/{task.subtask_count}
          </span>
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

      {(task.assigner_name || sent || linkCount > 0 || fileCount > 0 || task.permalink || task.comment_count > 0) && (
        <div className="card-foot">
          {task.assigner_name && <span title={`from ${task.assigner_name}`}>{task.assigner_name}</span>}
          {/* When it came in, not when we synced it - the age of an ask is
              half of how urgent it feels. */}
          {sent && (
            <span className="card-sent" title={sentFull(task.sent_at, task.sent_at_source)}>
              {task.assigner_name ? '· ' : ''}{sent}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {/* Whether the person who asked has been told is the thing you most
              want to see without opening the card. */}
          {task.replied_in_slack ? (
            <span className="replied" title="You replied in the Slack thread">✓ replied</span>
          ) : (
            task.comment_count > 0 && <span title={`${task.comment_count} comment(s)`}>💬 {task.comment_count}</span>
          )}
          {fileCount > 0 && <span title={`${fileCount} attachment(s)`}>📎 {fileCount}</span>}
          {linkCount > 0 && <span title={`${linkCount} link(s)`}>🔗 {linkCount}</span>}
          {task.permalink && (
            // stopPropagation, or opening Slack would also open the modal behind it.
            <a
              className="card-link"
              href={task.permalink}
              target="_blank"
              rel="noreferrer"
              title={task.source === 'email' ? 'Open the email thread' : `Open in Slack${task.channel_name ? ` · ${task.channel_name}` : ''}`}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              ↗ {task.source === 'email' ? 'Email' : 'Slack'}
            </a>
          )}
        </div>
      )}
    </article>
  );
}
