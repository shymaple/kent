import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import Modal from './Modal.jsx';
import { dueChipClass, dueLabel } from './TaskCard.jsx';

/** Local search over the board. Plain SQL on the server - never a model call. */
export default function CommandBar({ onPick, onClose, onError }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    // Debounced so a fast typist doesn't fire a query per keystroke.
    const t = setTimeout(async () => {
      try {
        setResults(await api.search(q.trim()));
        setActive(0);
      } catch (e) {
        onError(e.message);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [q, onError]);

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault();
      onPick(results[active]);
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="search-label">
      <div className="command-bar">
        <label id="search-label" className="sr-only" htmlFor="command-input">
          Search tasks
        </label>
        <input
          id="command-input"
          ref={inputRef}
          className="command-input"
          data-autofocus=""
          value={q}
          placeholder="Search tasks, messages, people, channels…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />

        {q.trim() && results.length === 0 && <p className="hint">No matches.</p>}

        <ul className="command-results">
          {results.map((t, i) => (
            <li key={t.id}>
              <button
                className={`command-result ${i === active ? 'active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(t)}
              >
                <span className={`dot ${t.priority}`} />
                <span className="command-title">{t.title}</span>
                {t.due_date && (
                  <span className={`chip ${dueChipClass(t.days_until_due)}`}>
                    {dueLabel(t.due_date, t.days_until_due)}
                  </span>
                )}
                {t.channel_name && <span className="chip">{t.channel_name}</span>}
              </button>
            </li>
          ))}
        </ul>

        <footer className="command-foot">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
        </footer>
      </div>
    </Modal>
  );
}
