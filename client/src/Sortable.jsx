import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import TaskCard from './TaskCard.jsx';

/**
 * A card that other cards move out of the way for.
 *
 * The lifted card is rendered separately in a DragOverlay, so the one left in
 * the column becomes a hole of exactly the right height. Everything below it
 * slides down under a transition, which is what makes the outcome of a drop
 * readable before you let go.
 */
export function SortableCard({ task, onOpen, onComplete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', listId: task.list_id },
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        // Keep the space, drop the contents: this is the gap the card will fill.
        opacity: isDragging ? 0 : 1,
      }}
      className="card-slot"
      {...attributes}
      {...listeners}
      aria-label={`${task.title}. Enter opens, Space picks up to move.`}
      // One tab stop per card: Enter opens it, Space lifts it for a keyboard
      // move (see the KeyboardSensor codes in Board). Keys from controls inside
      // the card are theirs, not the card's.
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' && !isDragging) {
          e.preventDefault();
          onOpen(task);
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
    >
      <TaskCard task={task} onOpen={onOpen} onComplete={onComplete} focusable={false} />
    </div>
  );
}

/** An empty column still has to be a drop target, or you can't move work into it. */
export function DroppableColumn({ list, isOver, children, ...rest }) {
  const { setNodeRef } = useDroppable({ id: `list-${list.id}`, data: { type: 'list', listId: list.id } });

  return (
    <section ref={setNodeRef} className={`column ${isOver ? 'drag-over' : ''}`} {...rest}>
      {children}
    </section>
  );
}
