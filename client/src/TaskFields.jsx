/**
 * The editable body of a task: the three quick attributes, then the detail.
 *
 * Every control saves as soon as you leave it — there is no Save button, so
 * `onCommit` is called with just the changed field. The description commits on
 * blur rather than on each keystroke, so a paragraph is one write, not eighty.
 */
import { useEffect, useState } from 'react';
import RichText, { plainToHtml } from './RichText.jsx';

const CATEGORIES = ['bug', 'review', 'meeting', 'admin', 'doc', 'followup', 'other'];

/**
 * A date field that reports once, when you leave it.
 *
 * Typed by keyboard, a date input fires a change for every digit - 0002, 0020,
 * 0202, 2026 are all "valid" years on the way to the one you meant. Saving each
 * of those wrote nonsense like 0005-02-12 to the card and re-rendered the board
 * under the cursor. A value picked from the calendar is still a single change;
 * it just lands when focus moves on, or when the dialog closes.
 */
export function AutoSaveDate({ id, value, onCommit, ...rest }) {
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);

  return (
    <input
      id={id}
      type="date"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== (value ?? '')) onCommit(draft || null);
      }}
      {...rest}
    />
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
          <AutoSaveDate
            id="task-due"
            value={task.due_date}
            onCommit={(due_date) => onCommit({ due_date })}
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

      <div className="field">
        <label htmlFor="task-desc">Description</label>
        <RichText
          id="task-desc"
          label="Description"
          // A description Kent wrote, or one from before the editor, is plain text.
          value={task.description_html ?? plainToHtml(task.description)}
          placeholder="Any detail worth keeping"
          onCommit={(description_html) => onCommit({ description_html })}
        />
      </div>
    </>
  );
}
