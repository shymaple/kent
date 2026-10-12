/**
 * The durable candidate queue.
 *
 * Slack is the only place a message can be lost from, so a candidate is written
 * to disk the instant the prefilter says it matches you — before the model is
 * consulted, and regardless of whether the model can be reached at all. A laptop
 * that was shut for three days, a Claude session that expired, a rate limit, a
 * crash mid-batch: none of them can drop a mention, because deciding whether it
 * is a task is a separate step that simply happens later.
 *
 * Entries leave the queue only once a verdict has been acted on — inboxed or
 * recorded as not-a-task. Anything else stays, with its attempt count and the
 * last thing that went wrong, so the failure is visible rather than silent.
 */
import { db } from './db.js';

const insert = db.prepare(`
  INSERT INTO pending_candidates
    (channel_id, channel_name, message_ts, thread_ts, assigner_id, assigner_name,
     reason, is_broadcast, sent_at, text, payload)
  VALUES
    (@channelId, @channelName, @messageTs, @threadTs, @assignerId, @assignerName,
     @reason, @isBroadcast, @sentAt, @text, @payload)
  ON CONFLICT (channel_id, message_ts) DO NOTHING
`);

const selectOldest = db.prepare(`
  SELECT * FROM pending_candidates ORDER BY sent_at, id LIMIT ?
`);

const remove = db.prepare('DELETE FROM pending_candidates WHERE id = ?');

const recordAttempt = db.prepare(`
  UPDATE pending_candidates
  SET attempts = attempts + 1, last_error = ?, last_attempt_at = datetime('now')
  WHERE id = ?
`);

/**
 * Queue a candidate. Idempotent per (channel, message): a message that is
 * already waiting is never queued twice, so a re-sync of the same window is
 * free.
 *
 * @returns true if this call added it
 */
export function enqueueCandidate(candidate) {
  const info = insert.run({
    channelId: candidate.channelId,
    channelName: candidate.channelName,
    messageTs: candidate.messageTs,
    threadTs: candidate.threadTs ?? null,
    assignerId: candidate.assignerId ?? null,
    assignerName: candidate.assignerName ?? null,
    reason: candidate.reason ?? 'mention',
    isBroadcast: candidate.isBroadcast ? 1 : 0,
    sentAt: candidate.sentAt,
    text: candidate.text ?? '',
    // Files and attachments ride along so link extraction still works days
    // later, without going back to Slack for a message we already have.
    payload: JSON.stringify(candidate),
  });
  return info.changes > 0;
}

/** Rebuild the candidate the sync loop works with, plus its queue row id. */
export function toCandidate(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payload) ?? {};
  } catch {
    // A corrupt payload must not strand the row; the columns carry the essentials.
  }
  return {
    ...payload,
    queueId: row.id,
    id: `${row.channel_id}:${row.message_ts}`,
    channelId: row.channel_id,
    channelName: row.channel_name,
    channel: payload.channel ?? row.channel_name,
    messageTs: row.message_ts,
    threadTs: row.thread_ts,
    assignerId: row.assigner_id,
    assignerName: row.assigner_name,
    from: payload.from ?? row.assigner_name ?? 'unknown',
    reason: row.reason,
    isBroadcast: Boolean(row.is_broadcast),
    sentAt: row.sent_at,
    text: row.text,
    attempts: row.attempts,
  };
}

/** The oldest waiting candidates first — a backlog is drained in Slack order. */
export function queuedCandidates(limit = 150) {
  return selectOldest.all(limit).map(toCandidate);
}

export const dropCandidate = (queueId) => remove.run(queueId);

/** Leave a candidate queued, but record why this attempt didn't settle it. */
export function markAttemptFailed(queueIds, error) {
  const message = String(error ?? '').slice(0, 300);
  db.transaction(() => {
    for (const id of queueIds) recordAttempt.run(message, id);
  })();
}

/** What the UI needs to say "N messages are waiting for Claude". */
export function queueStats() {
  const row = db
    .prepare(
      `SELECT COUNT(*) waiting, MIN(sent_at) oldest_at, MAX(attempts) attempts
       FROM pending_candidates`
    )
    .get();
  const lastError = db
    .prepare(
      `SELECT last_error FROM pending_candidates
       WHERE last_error IS NOT NULL ORDER BY last_attempt_at DESC LIMIT 1`
    )
    .get();
  return {
    waiting: row?.waiting ?? 0,
    oldest_at: row?.oldest_at ?? null,
    attempts: row?.attempts ?? 0,
    last_error: lastError?.last_error ?? null,
  };
}
