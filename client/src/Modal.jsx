import { useEffect, useRef } from 'react';

/**
 * Dialog shell used by every overlay in the app.
 *
 * Closes on Escape and on a backdrop click, traps Tab inside itself while open,
 * locks background scrolling, and returns focus to whatever opened it.
 *
 * The setup effect runs once per dialog, never per render. It used to depend on
 * `onClose`, which callers pass as an inline arrow, so every re-render of the
 * parent tore the effect down and ran it again - and running it again moves
 * focus. In the new-task dialog that meant one keystroke in Description threw
 * the cursor back to Title; in the task modal, any autosave or background
 * status poll pulled focus out of the field being typed in.
 */
export default function Modal({ onClose, labelledBy, children, wide = false }) {
  const panelRef = useRef(null);
  const returnFocusTo = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /**
   * Fields save when they are left, and an unmounting field never gets a blur.
   * Leaving it by hand first is what makes "close the dialog" unable to drop
   * the last thing typed.
   */
  function close() {
    const el = document.activeElement;
    if (el && el !== panelRef.current && panelRef.current?.contains(el)) el.blur();
    onCloseRef.current();
  }

  useEffect(() => {
    returnFocusTo.current = document.activeElement;

    // `main` is the scrolling element now, not the window, so locking the body
    // alone would leave the page scrolling behind the dialog.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');

    const focusables = () =>
      [...(panelRef.current?.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? [])].filter((el) => el.offsetParent !== null);

    // Focus the dialog itself, not its first control. Grabbing the first
    // control put the task modal's title into edit mode the moment it opened,
    // which is not what anyone asked for by clicking a card. A dialog that
    // wants a field focused says so with [data-autofocus].
    const wanted = panelRef.current?.querySelector('[data-autofocus]');
    (wanted ?? panelRef.current)?.focus();

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        // A field that gives Escape its own meaning (revert this edit) keeps
        // it; the next Escape, from outside the field, closes the dialog.
        if (e.target.closest?.('[data-own-escape]')) return;
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;

      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      document.body.classList.remove('modal-open');
      returnFocusTo.current?.focus?.();
    };
  }, []);

  return (
    <div
      className="backdrop"
      // Only a click that starts AND ends on the backdrop closes it, so
      // dragging a text selection out of the panel doesn't dismiss your edits.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        ref={panelRef}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
