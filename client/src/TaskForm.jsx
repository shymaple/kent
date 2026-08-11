/**
 * The full task field set, shared by "add task" and the detail modal so the two
 * can never drift apart.
 */
const CATEGORIES = ['bug', 'review', 'meeting', 'admin', 'doc', 'followup', 'other'];

export default function TaskForm({ value, onChange, lists = [], showList = true, autoFocus }) {
  const set = (patch) => onChange({ ...value, ...patch });

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
        <textarea
          id="task-desc"
          value={value.description ?? ''}
          maxLength={2000}
          placeholder="Any detail worth keeping"
          onChange={(e) => set({ description: e.target.value })}
        />
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
