/**
 * The full task field set, shared by "add task" and the detail modal so the two
 * can never drift apart.
 */
import RichText, { linksIn } from './RichText.jsx';

const CATEGORIES = ['bug', 'review', 'meeting', 'admin', 'doc', 'followup', 'other'];

export default function TaskForm({ value, onChange, lists = [], showList = true, autoFocus }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const found = linksIn(value.description_html);

  return (
    <>
      <div className="field">
        <label htmlFor="task-title">Title</label>
        <input
          id="task-title"
          autoFocus={autoFocus}
          data-autofocus={autoFocus ? '' : undefined}
          value={value.title ?? ''}
          maxLength={120}
          placeholder="What needs doing?"
          onChange={(e) => set({ title: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="task-desc">Description</label>
        <RichText
          id="task-desc"
          label="Description"
          value={value.description_html ?? ''}
          placeholder="Any detail worth keeping"
          onChange={(description_html) => set({ description_html })}
        />
        {found.length > 0 && (
          <p className="hint" style={{ margin: '6px 0 0' }}>
            {found.length === 1 ? 'This link' : `These ${found.length} links`} will be listed under
            Links on the task: {found.map((u) => u.replace(/^https?:\/\//, '').slice(0, 40)).join(', ')}
          </p>
        )}
      </div>

      <div className="field-row">
        <div>
          <label htmlFor="task-priority">Priority</label>
          <select
            id="task-priority"
            value={value.priority ?? 'medium'}
            onChange={(e) => set({ priority: e.target.value })}
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
            value={value.due_date ?? ''}
            onChange={(e) => set({ due_date: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="task-category">Category</label>
          <select
            id="task-category"
            value={CATEGORIES.includes(value.category) ? value.category : 'other'}
            onChange={(e) => set({ category: e.target.value })}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Where it came from. Optional, and collapsed until wanted: most tasks
          typed in by hand didn't come from anywhere. */}
      <details className="origin" open={Boolean(value.permalink || value.assigner_name || value.channel_name)}>
        <summary>Where it came from (optional)</summary>
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="task-permalink">Slack message link</label>
          <input
            id="task-permalink"
            type="url"
            value={value.permalink ?? ''}
            placeholder="https://your-workspace.slack.com/archives/C…/p…"
            onChange={(e) => set({ permalink: e.target.value })}
          />
        </div>
        <div className="field-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div>
            <label htmlFor="task-from">From</label>
            <input
              id="task-from"
              value={value.assigner_name ?? ''}
              maxLength={80}
              placeholder="Who asked"
              onChange={(e) => set({ assigner_name: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="task-channel">Channel</label>
            <input
              id="task-channel"
              value={value.channel_name ?? ''}
              maxLength={80}
              placeholder="e.g. eng"
              onChange={(e) => set({ channel_name: e.target.value })}
            />
          </div>
        </div>
      </details>

      {showList && lists.length > 0 && (
        <div className="field">
          <label htmlFor="task-list">List</label>
          <select
            id="task-list"
            value={value.list_id ?? lists[0]?.id}
            onChange={(e) => set({ list_id: Number(e.target.value) })}
          >
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}
