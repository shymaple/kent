/**
 * The editable body of a task: the three quick attributes, then the detail.
 *
 * Every control saves as soon as you leave it — there is no Save button, so
 * `onCommit` is called with just the changed field. Text areas commit on blur
 * rather than on each keystroke, so a paragraph is one write, not eighty.
 */
import { useEffect, useState } from 'react';

const CATEGORIES = ['bug', 'review', 'meeting', 'admin', 'doc', 'followup', 'other'];

/** A textarea that keeps its own draft and reports the value when you leave it. */
function AutoSaveText({ id, label, value, placeholder, rows, onCommit }) {
  const [draft, setDraft] = useState(value ?? '');

  // Follow the task if it changes underneath us (another edit, a sync), but
  // never clobber what the user is part-way through typing.
  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={rows}
        value={draft}
        placeholder={placeholder}
        maxLength={2000}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next !== (value ?? '')) onCommit(next || null);
        }}
      />
    </div>
  );
}

export default function TaskFields({ task, onCommit }) {
  return (
    <>
      <div className="field-row">
        <div>
          <label htmlFor="task-priority">Priority</label>
          <select
            id="task-priority"
            value={task.priority ?? 'medium'}
            onChange={(e) => onCommit({ priority: e.target.value })}
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div>
          <label htmlFor="task-due">Due date</label>
          <input
            id="task-due"
            type="date"
            value={task.due_date ?? ''}
            onChange={(e) => onCommit({ due_date: e.target.value || null })}
          />
        </div>
        <div>
          <label htmlFor="task-category">Category</label>
          <select
            id="task-category"
            value={CATEGORIES.includes(task.category) ? task.category : 'other'}
            onChange={(e) => onCommit({ category: e.target.value })}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      <AutoSaveText
        id="task-desc"
        label="Description"
        rows={3}
        value={task.description}
        placeholder="Any detail worth keeping"
        onCommit={(description) => onCommit({ description })}
      />
    </>
  );
}
