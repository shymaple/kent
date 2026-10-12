/**
 * Make a task from one Slack message the user points at.
 *
 * Sync only catches messages that address you. Plenty of real work doesn't: a
 * thread you were told about in a meeting, a request to the team that became
 * yours, something from before Kent was installed. The way to get those onto
 * the board was to retype them - title, who asked, which channel, the link -
 * which is exactly the copying Kent exists to remove.
 *
 * Here the link is the whole input. The message is read from Slack, the model
 * is asked once to phrase it as a task (title, deadline, priority), and the card
 * is created with its sender, channel, thread and attachments filled in, so it
 * can be replied to like any other.
 *
 * Two deliberate differences from the sync path:
 *
 * - There is no "is this a task?" gate. The user said it is one by pasting it;
 *   the model only describes it. If the model can't be reached the card is still
 *   made, titled from the message's first line - a rough card now beats an error.
 * - It goes straight onto the board, not through the Inbox. Triage is for
 *   things Kent found; this is something the user chose.
 *
 * The message is marked seen, so a later sync that would also have caught it
 * (it did mention you) doesn't offer it a second time.
 */
import { db, getSetting, listIdForStatus, statusForList } from './db.js';
import { hasSlackToken } from './secrets.js';
import * as slack from './slack.js';
import { classifyBatch } from './classify.js';
import { enrich } from './enrich.js';
import { parseSlackLink } from './slacklink.js';
import { renderSlackText } from './render.js';

/** An error the route can hand straight to the browser. */
function refuse(status, userMessage, extra = {}) {
  const err = new Error(userMessage);
  err.status = status;
  err.userMessage = userMessage;
  Object.assign(err, extra);
  return err;
}

const existingTask = db.prepare(
  'SELECT * FROM tasks WHERE channel_id = ? AND message_ts = ? AND archived_at IS NULL ORDER BY id DESC LIMIT 1'
);
const markSeen = db.prepare(`
  INSERT INTO seen_messages (channel_id, message_ts, outcome) VALUES (?, ?, 'inboxed')
  ON CONFLICT(channel_id, message_ts) DO UPDATE SET outcome = 'inboxed'
`);

const SLACK_REFUSALS = {
  channel_not_found: 'Kent can’t see that conversation. You need to be a member of it in Slack.',
  not_in_channel: 'Kent can’t see that conversation. You need to be a member of it in Slack.',
  missing_scope: 'Your Slack token is missing a scope needed to read that conversation. See Settings.',
  thread_not_found: 'That message no longer exists in Slack.',
  invalid_auth: 'Slack rejected the token. Reconnect Slack in Settings.',
  token_revoked: 'Slack rejected the token. Reconnect Slack in Settings.',
};

/**
 * @param url   the pasted link
 * @param opts  { listId?, classifier? } - classifier is injectable for tests
 * @returns the new task row (raw, as stored)
 */
export async function importSlackMessage(url, { listId, classifier = classifyBatch } = {}) {
  // Shape first, with no I/O: nothing that isn't a message link reaches Slack.
  const link = parseSlackLink(url, { teamDomain: getSetting('slack_team_domain') });
  if (!link.ok) throw refuse(400, link.error, { code: link.code });

  if (!hasSlackToken()) throw refuse(400, 'Connect Slack in Settings first.');

  const already = existingTask.get(link.channelId, link.ts);
  if (already) {
    throw refuse(409, 'That message is already on your board.', { code: 'exists', taskId: already.id });
  }

  let message;
  try {
    message = await slack.fetchMessage(link.channelId, link.ts, link.threadTs);
  } catch (err) {
    throw refuse(502, SLACK_REFUSALS[err.code] ?? 'Slack would not hand over that message. Try again in a moment.');
  }
  if (!message?.text?.trim()) {
    throw refuse(404, 'Slack has no message at that link. It may have been deleted.');
  }

  const channel = db.prepare('SELECT name FROM channels WHERE id = ?').get(link.channelId);
  const person = message.user
    ? db.prepare('SELECT display_name FROM people WHERE slack_user_id = ?').get(message.user)
    : null;
  const assignerName = person?.display_name ?? message.username ?? message.user ?? null;
  const timezone = getSetting('timezone');
  const sentAt = slack.tsToDate(message.ts);
  const threadTs = message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : link.threadTs;

  const candidate = {
    id: `${link.channelId}:${message.ts}`,
    channel: channel?.name ?? link.channelId,
    from: assignerName ?? 'unknown',
    sentAt: sentAt.toISOString(),
    // The model gets names, not member ids, or the title comes back as "Ask U02AB…".
    text: renderSlackText(message.text),
    isBroadcast: false,
  };

  // One call, and optional: a card titled from the first line is still a card.
  let verdict = null;
  let phrasedByModel = false;
  try {
    const result = await classifier([candidate], { model: getSetting('model'), timezone });
    verdict = result.verdicts.get(candidate.id) ?? null;
    phrasedByModel = Boolean(verdict?.title);
  } catch (err) {
    console.error('[import] could not phrase the task, using the message as-is:', err.detail ?? err.message);
  }

  const card = enrich(
    // The raw text, not the rendered one: Slack's <url|label> markup is where
    // the links are, and rendering it for the model throws the addresses away.
    { ...candidate, text: message.text, sentAt, files: message.files, attachments: message.attachments, reason: 'imported' },
    verdict?.title ? verdict : null,
    { timezone }
  );

  const permalink =
    (await slack.getPermalink(link.channelId, message.ts, { teamUrl: getSetting('slack_team_domain') })) ?? link.url;

  const targetList =
    listId && db.prepare('SELECT 1 FROM lists WHERE id = ?').get(listId) ? Number(listId) : listIdForStatus('open');

  const taskId = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO tasks
        (title, description, status, list_id, priority, due_date, category, is_broadcast, position,
         channel_id, channel_name, message_ts, thread_ts, permalink,
         assigner_id, assigner_name, links, source_text, confidence)
      VALUES
        (@title, @description, @status, @listId, @priority, @dueDate, @category, 0,
         (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE list_id = @listId),
         @channelId, @channelName, @messageTs, @threadTs, @permalink,
         @assignerId, @assignerName, @links, @sourceText, @confidence)
    `).run({
      title: renderSlackText(card.title).slice(0, 120),
      description: card.description,
      status: statusForList(targetList),
      listId: targetList,
      priority: card.priority,
      dueDate: card.dueDate,
      category: card.category,
      channelId: link.channelId,
      channelName: channel?.name ?? link.channelId,
      messageTs: message.ts,
      threadTs: threadTs ?? null,
      permalink,
      assignerId: message.user ?? null,
      assignerName,
      links: JSON.stringify(card.links),
      sourceText: message.text,
      confidence: verdict?.confidence ?? null,
    });

    // Don't let a sync offer the same message again, and retire it if it is
    // already sitting in triage or waiting on the model.
    markSeen.run(link.channelId, message.ts);
    db.prepare("UPDATE inbox_items SET state = 'approved' WHERE channel_id = ? AND message_ts = ? AND state = 'pending'")
      .run(link.channelId, message.ts);
    db.prepare('DELETE FROM pending_candidates WHERE channel_id = ? AND message_ts = ?')
      .run(link.channelId, message.ts);
    return info.lastInsertRowid;
  })();

  return { task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId), phrasedByModel };
}
