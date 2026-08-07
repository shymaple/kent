/**
 * Deterministic post-processing of a model verdict.
 *
 * Anything that can be decided by a rule is decided here, not in the prompt:
 * priority people, broadcast demotion, links, and deadline sanity. This keeps
 * the prompt short and makes the important behaviour testable.
 */
import { extractLinks } from './prefilter.js';

/** YYYY-MM-DD for a Date, in the given IANA timezone. */
export function localDateString(date, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Merge a verdict with the raw candidate into the row we will store.
 *
 * @param candidate { id, text, sentAt(Date), channelId, channelName, messageTs,
 *                    threadTs, permalink, assignerId, assignerName, reason, isBroadcast }
 * @param verdict   validated model output (or null if the model skipped it)
 * @param ctx       { isPriorityPerson: boolean, timezone: string }
 */
export function enrich(candidate, verdict, ctx = {}) {
  const { isPriorityPerson = false, timezone = 'UTC' } = ctx;

  const title =
    verdict?.title || firstLine(candidate.text) || `Message from ${candidate.assignerName ?? 'Slack'}`;

  let priority = verdict?.priority ?? 'medium';
  let dueDate = verdict?.dueDate ?? null;

  // A deadline already in the past is a parsing artefact, not a deadline.
  if (dueDate && dueDate < localDateString(candidate.sentAt ?? new Date(), timezone)) {
    dueDate = null;
  }

  // Priority people win over the model, always.
  if (isPriorityPerson) priority = 'high';

  // Channel-wide broadcasts are noise by definition - never let one shout.
  if (candidate.isBroadcast) priority = 'low';

  return {
    title,
    description: verdict?.description ?? null,
    priority,
    dueDate,
    category: candidate.isBroadcast ? 'broadcast' : verdict?.category ?? 'other',
    isBroadcast: candidate.isBroadcast ? 1 : 0,
    confidence: verdict?.confidence ?? 0.4,
    links: extractLinks({
      text: candidate.text,
      files: candidate.files,
      attachments: candidate.attachments,
    }),
    reason: candidate.reason,
  };
}

function firstLine(text = '') {
  const line = String(text).split('\n').find((l) => l.trim());
  if (!line) return '';
  return line.trim().slice(0, 100);
}

/** Days until a due date, relative to today in the user's timezone. Null-safe. */
export function daysUntil(dueDate, timezone) {
  if (!dueDate) return null;
  const today = localDateString(new Date(), timezone);
  const ms = Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
