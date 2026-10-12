/**
 * The email half of a sync: read new mail, keep what is addressed to you, and
 * put it on the same durable queue Slack candidates wait on.
 *
 * It stops there on purpose. Judging, the confidence floor, the "this is social"
 * and "this already expired" backstops and the write to the Inbox all happen in
 * sync.js for whatever is on the queue - so an email is held to exactly the bar
 * a Slack message is, and the queue's promise holds for it too: once captured, a
 * shut laptop or a signed-out Claude can delay the verdict but not lose the mail.
 *
 * Two things are specific to mail:
 *
 * - A thread is one conversation. When a new ask arrives in a thread that
 *   already has a card, it is queued as a follow-up *to that card* and surfaces
 *   in the Inbox as a proposed subtask, not as a second card for the same work.
 * - "Handled" means you replied. If anything you sent sits later in the thread
 *   than the message in question, it never reaches triage - the email
 *   counterpart of handled.js, and what keeps a wake-up backlog readable.
 */
import { db, getAliases, getSetting, setSetting } from './db.js';
import * as gmail from './gmail.js';
import { classifyMail } from './mailfilter.js';
import { buildAliasMatcher } from './prefilter.js';
import { enqueueCandidate } from './queue.js';

export const MAIL_CHANNEL = 'gmail';

const seenStmt = db.prepare('SELECT 1 FROM seen_messages WHERE channel_id = ? AND message_ts = ?');
const markSeen = db.prepare(`
  INSERT INTO seen_messages (channel_id, message_ts, outcome) VALUES (?, ?, ?)
  ON CONFLICT(channel_id, message_ts) DO UPDATE SET outcome = excluded.outcome
`);
const findTaskByThread = db.prepare(`
  SELECT id, title FROM tasks
  WHERE channel_id = ? AND thread_ts = ? AND archived_at IS NULL
  ORDER BY id DESC LIMIT 1
`);

/**
 * Read mail newer than the cursor and queue the candidates.
 *
 * @returns { scanned, candidates, handled, catchingUp, cursor } - `cursor` is
 *   the value to store once the caller has finished queueing, never before.
 */
export async function collectMail({ onLog = () => {} } = {}) {
  const result = { scanned: 0, candidates: 0, handled: 0, catchingUp: false, cursor: null };

  let myAddress = getSetting('gmail_address');
  if (!myAddress) {
    myAddress = (await gmail.getProfile()).address;
    setSetting('gmail_address', myAddress);
  }

  // No cursor yet means "start from now", the same promise Slack makes with a
  // zero backfill: connecting must not drag weeks of old mail onto the board.
  const stored = Number(getSetting('gmail_cursor'));
  if (!Number.isFinite(stored) || stored <= 0) {
    const rawBackfill = Number(getSetting('backfill_days'));
    const days = Number.isFinite(rawBackfill) && rawBackfill >= 0 ? rawBackfill : 0;
    const start = Math.floor(Date.now() / 1000) - days * 86_400;
    if (days === 0) {
      result.cursor = start;
      return result;
    }
    setSetting('gmail_cursor', start);
  }
  const after = Number(getSetting('gmail_cursor'));

  const { ids, truncated } = await gmail.listMessageIds({ after });
  const batch = ids.slice(0, gmail.READ_LIMIT);
  result.catchingUp = truncated || ids.length > batch.length;

  const aliasMatcher = buildAliasMatcher(getAliases());
  const autoRetire = getSetting('auto_retire_handled') !== 'false';
  let newest = after;

  for (const { id, threadId } of batch) {
    if (seenStmt.get(MAIL_CHANNEL, id)) continue;

    const mail = await gmail.getMessage(id);
    result.scanned++;
    newest = Math.max(newest, Math.floor(mail.internalDate / 1000));

    const hit = classifyMail(mail, { myAddress, aliasMatcher });
    if (!hit) continue;

    if (autoRetire) {
      try {
        const thread = await gmail.getThreadMeta(threadId);
        const replied = thread.some((m) => m.labelIds.includes('SENT') && m.internalDate > mail.internalDate);
        if (replied) {
          markSeen.run(MAIL_CHANNEL, id, 'handled');
          result.handled++;
          continue;
        }
      } catch {
        // Could not read the thread; err on the side of showing the mail.
      }
    }

    const parent = findTaskByThread.get(MAIL_CHANNEL, threadId);

    result.candidates++;
    enqueueCandidate({
      id: `${MAIL_CHANNEL}:${id}`,
      source: 'email',
      channel: 'email',
      channelId: MAIL_CHANNEL,
      channelName: 'Email',
      messageTs: id,
      threadTs: threadId,
      from: mail.from.name,
      assignerId: mail.from.email,
      assignerName: mail.from.name,
      sentAt: new Date(mail.internalDate).toISOString(),
      text: mail.text,
      permalink: gmail.threadUrl(threadId),
      reason: hit.reason,
      isBroadcast: hit.isBroadcast,
      ...(parent
        ? {
            parentTaskId: parent.id,
            threadContext: `A later email in a thread already tracked as the task "${parent.title}".`,
          }
        : {}),
    });
    markSeen.run(MAIL_CHANNEL, id, 'queued');
  }

  if (result.catchingUp) onLog(`more email is waiting than one pass reads; continuing on the next sync`);
  result.cursor = newest;
  return result;
}
