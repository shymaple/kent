/**
 * The description editor: bold, italic, lists, links - and nothing else.
 *
 * A description was a plain textarea, which could hold "Blocking the release"
 * and not much more. What people actually put on a task is a few steps, one
 * emphasised caveat and a link, and in plain text that came out as a wall.
 *
 * It is a contentEditable box rather than an editor library on purpose: the
 * client has no dependency for this, and four formatting commands don't need
 * one. Two things keep that honest:
 *
 * - React never re-renders the box's contents. The markup is written once and
 *   again only when the value changes *from outside* while the box isn't
 *   focused. Re-writing it on each keystroke is what throws the caret to the
 *   start of the field - the same class of bug that used to bounce the cursor
 *   out of Description altogether.
 * - What leaves here is not trusted by anyone. The server rebuilds the markup
 *   from an allowlist before storing it (server/richtext.js), so this component
 *   only has to be pleasant, not safe. Paste comes in as plain text, so a
 *   copied web page can't bring its styling along.
 */
import { useEffect, useRef, useState } from 'react';

const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A plain-text description (from Slack, or written before the editor existed) as markup. */
export function plainToHtml(text) {
  return escapeHtml(text ?? '').replace(/\r?\n/g, '<br>');
}

/** Every http(s) URL visible in a piece of editor markup - typed out or behind a link. */
export function linksIn(html) {
  const found = new Set();
  const source = String(html ?? '');
  for (const m of source.matchAll(/href="(https?:[^"]+)"/g)) found.add(m[1].replace(/&amp;/g, '&'));
  const text = source.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/g)) found.add(m[0].replace(/[).,;]+$/, ''));
  return [...found];
}

const isBlank = (el) => !el.textContent.trim() && !el.querySelector('li, a');

const TOOLS = [
  { command: 'bold', label: 'B', title: 'Bold (⌘B)', style: { fontWeight: 700 } },
  { command: 'italic', label: 'I', title: 'Italic (⌘I)', style: { fontStyle: 'italic' } },
  { command: 'insertUnorderedList', label: '• List', title: 'Bulleted list' },
  { command: 'insertOrderedList', label: '1. List', title: 'Numbered list' },
];

/**
 * @param value     markup to show (use `plainToHtml` for a plain description)
 * @param onChange  called with the markup on every edit - for forms that hold a draft
 * @param onCommit  called with the markup when the field is left, if it changed
 */
export default function RichText({ id, value, placeholder, label, onChange, onCommit }) {
  const boxRef = useRef(null);
  const savedRange = useRef(null);
  const committed = useRef(value ?? '');
  // Fixed for the life of the component - the same *object*, not just the same
  // string. React compares this prop by identity and re-applies innerHTML when
  // it differs, so a fresh `{ __html }` per render wiped the box on every
  // keystroke. Later outside changes go through the effect below instead.
  const [initial] = useState(() => ({ __html: value ?? '' }));
  const [empty, setEmpty] = useState(() => !String(value ?? '').replace(/<[^>]*>/g, '').trim());
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState('');

  useEffect(() => {
    const box = boxRef.current;
    const next = value ?? '';
    if (!box || document.activeElement === box || next === committed.current) return;
    committed.current = next;
    box.innerHTML = next;
    setEmpty(isBlank(box));
  }, [value]);

  const read = () => {
    const box = boxRef.current;
    return isBlank(box) ? '' : box.innerHTML;
  };

  function changed() {
    setEmpty(isBlank(boxRef.current));
    onChange?.(read());
  }

  function run(command, argument) {
    boxRef.current.focus();
    document.execCommand(command, false, argument);
    changed();
  }

  function openLink() {
    // The selection is lost the moment the URL field takes focus; keep it.
    const selection = window.getSelection();
    savedRange.current =
      selection.rangeCount && boxRef.current.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
    setUrl('');
    setLinking(true);
  }

  function applyLink() {
    const raw = url.trim();
    setLinking(false);
    if (!raw) return;
    const href = /^(https?:\/\/|mailto:)/i.test(raw) ? raw : `https://${raw}`;

    const box = boxRef.current;
    box.focus();
    const selection = window.getSelection();
    if (savedRange.current) {
      selection.removeAllRanges();
      selection.addRange(savedRange.current);
    }
    if (selection.isCollapsed) {
      document.execCommand('insertHTML', false, `<a href="${escapeHtml(href).replace(/"/g, '&quot;')}">${escapeHtml(href)}</a>&nbsp;`);
    } else {
      document.execCommand('createLink', false, href);
    }
    changed();
  }

  return (
    <div className="rich">
      <div className="rich-tools" role="toolbar" aria-label="Formatting">
        {TOOLS.map((tool) => (
          <button
            key={tool.command}
            type="button"
            className="tiny"
            title={tool.title}
            style={tool.style}
            // mousedown, not click: a click would move focus out of the box
            // first and there would be no selection left to format.
            onMouseDown={(e) => {
              e.preventDefault();
              run(tool.command);
            }}
          >
            {tool.label}
          </button>
        ))}
        <button
          type="button"
          className="tiny"
          title="Add a link"
          onMouseDown={(e) => {
            e.preventDefault();
            openLink();
          }}
        >
          🔗 Link
        </button>
      </div>

      {linking && (
        <div className="row rich-link">
          <input
            autoFocus
            data-own-escape=""
            value={url}
            placeholder="Paste or type a link, then press Enter"
            aria-label="Link address"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                applyLink();
              }
              if (e.key === 'Escape') setLinking(false);
            }}
          />
          <button type="button" className="small" onMouseDown={(e) => { e.preventDefault(); applyLink(); }}>
            Add
          </button>
        </div>
      )}

      <div
        id={id}
        ref={boxRef}
        className={`rich-box ${empty ? 'is-empty' : ''}`}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        data-placeholder={placeholder}
        dangerouslySetInnerHTML={initial}
        onInput={changed}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
        onBlur={() => {
          const next = read();
          if (next === committed.current) return;
          committed.current = next;
          onCommit?.(next);
        }}
      />
    </div>
  );
}
