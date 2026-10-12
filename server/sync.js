/**
 * The sync loop: fetch -> prefilter -> classify -> inbox.
 *
 * Cost shape: steps 1-3 are pure Slack + string matching. The model is only
 * invoked in step 4, and only when candidates exist. A sync over a quiet
 * workspace makes zero LLM calls.
 */
import { db, getAliases, getSetting, setSetting } from './db.js';
import { hasGmail, hasSlackToken } from './secrets.js';
import { collectMail } from './mailsync.js';
import * as slack from './slack.js';
import { buildAliasMatcher, classifyCandidate } from './prefilter.js';
import { chunk, classifyBatch } from './classify.js';
import { enrich } from './enrich.js';
import { handledInSlack, handledLabel, parseHandledReactions } from './handled.js';
import { looksEphemeral } from './ephemeral.js';
import { looksSocial } from './social.js';
import {
  dropCandidate, enqueueCandidate, markAttemptFailed, queueStats, queuedCandidates,
} from './queue.js';

let running = false;
let timer = null;

export const isRunning = () => running;

let lastUserRefresh = 0;
const USER_REFRESH_MS = 60 * 60 * 1000;

/**
 * Refresh the channel and people directories from Slack.
 *
 * The member list is paginated and rarely changes, so it is refreshed at most
 * hourly during background syncs. `force` (the Refresh list button, connecting a
 * token) always re-reads it.
 */
export async function refreshDirectories({ force = true } = {}) {
  const me = await slack.authTest();
  setSetting('slack_user_id', me.userId);
  setSetting('slack_team_domain', me.url ?? '');

  const refreshUsers = force || Date.now() - lastUserRefresh > USER_REFRESH_MS;
  const [conversations, users] = await Promise.all([
    slack.listMyConversations(),
    refreshUsers ? slack.listUsers() : Promise.resolve(null),
  ]);
  if (refreshUsers) lastUserRefresh = Date.now();
  const byId = new Map(
    (users ?? db.prepare('SELECT slack_user_id, display_name FROM people').all().map((r) => ({
      id: r.slack_user_id,
      displayName: r.display_name,
    }))).map((u) => [u.id, u])
  );

  const upsertChannel = db.prepare(`
    INSERT INTO channels (id, name, kind, is_member, updated_at)
    VALUES (@id, @name, @kind, 1, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, kind = excluded.kind, is_member = 1, updated_at = datetime('now')
  `);
  const upsertPerson = db.prepare(`
    INSERT INTO people (slack_user_id, display_name, real_name, is_priority)
    VALUES (@id, @displayName, @realName, 0)
    ON CONFLICT(slack_user_id) DO UPDATE SET
      display_name = excluded.display_name, real_name = excluded.real_name
  `);

  db.transaction(() => {
    // Anything we knew about that is no longer returned means we left it.
    db.prepare('UPDATE channels SET is_member = 0').run();
    for (const c of conversations) {
      // DMs come back without a name; label them with the other person.
      const name = c.kind === 'im' ? `@${byId.get(c.user)?.displayName ?? c.user}` : c.name;
      upsertChannel.run({ id: c.id, name, kind: c.kind });
    }
    for (const u of users ?? []) {
      if (u.isBot) continue;
      upsertPerson.run(u);
    }
  })();

  return {
    me,
    channels: conversations.length,
    users: users?.length ?? db.prepare('SELECT COUNT(*) n FROM people').get().n,
  };
}

const selectActiveChannels = db.prepare(
  'SELECT * FROM channels WHERE is_member = 1 AND is_excluded = 0'
);
const seenStmt = db.prepare('SELECT 1 FROM seen_messages WHERE channel_id = ? AND message_ts = ?');
const markSeen = db.prepare(`
  INSERT INTO seen_messages (channel_id, message_ts, outcome) VALUES (?, ?, ?)
  ON CONFLICT(channel_id, message_ts) DO UPDATE SET outcome = excluded.outcome
`);
const setCursor = db.prepare('UPDATE channels SET last_synced_ts = ? WHERE id = ?');
const priorityPeople = db.prepare('SELECT slack_user_id FROM people WHERE is_priority = 1');
const findTaskByThread = db.prepare(`
  SELECT id, due_date FROM tasks
  WHERE channel_id = ? AND thread_ts = ? AND archived_at IS NULL
  ORDER BY id DESC LIMIT 1
`);

/** Messages judged in one sync. A backlog is drained over several passes. */
const DRAIN_LIMIT = 150;

/**
 * A candidate has a verdict and has been acted on: record the outcome and take
 * it off the queue. The two must move together, or a crash between them would
 * either lose the message or triage it twice.
 */
const settle = db.transaction((candidate, outcome) => {
  markSeen.run(candidate.channelId, candidate.messageTs, outcome);
  if (candidate.queueId) dropCandidate(candidate.queueId);
});

// ------------------------------------------------- already handled in Slack

/** Pending triage items are re-checked oldest first, this many per sync. */
const RECHECK_LIMIT = 25;

const pendingInbox = db.prepare(`
  SELECT id, channel_id, channel_name, message_ts, thread_ts FROM inbox_items
  WHERE state = 'pending' AND source = 'slack' ORDER BY id LIMIT ?
`);
const retireInbox = db.prepare("UPDATE inbox_items SET state = 'dismissed' WHERE id = ?");
const commentExists = db.prepare('SELECT 1 FROM comments WHERE task_id = ? AND slack_ts = ?');
const insertSlackComment = db.prepare(`
  INSERT INTO comments (task_id, body, kind, slack_ts, posted_at)
  VALUES (?, ?, 'slack', ?, ?)
`);

/**
 * Record replies I wrote in Slack myself against the card they belong to.
 *
 * Without this, a card only ever shows "replied" when the reply went through
 * Kent's composer — so answering from your phone left the board claiming you
 * had ignored someone. Reads only messages this sync already fetched.
 */
function mirrorMyReplies(channelId, myUserId, messages) {
  if (!myUserId) return 0;
  let added = 0;
  for (const m of messages) {
    if (m.user !== myUserId || !m.thread_ts || m.thread_ts === m.ts || !m.text?.trim()) continue;
    const task = findTaskByThread.get(channelId, m.thread_ts);
    if (!task || commentExists.get(task.id, m.ts)) continue;
    insertSlackComment.run(task.id, m.text, m.ts, slack.tsToDate(m.ts).toISOString());
    added++;
  }
  return added;
}

/**
 * Retire triage items that were dealt with in Slack after they were queued.
 *
 * The backlog that lands after a few days away is the case this exists for: you
 * answered half of it from your phone, and none of that half should be asking
 * for a decision now. One thread read per item, oldest first and capped, so a
 * large inbox costs a bounded number of calls.
 */
async function retireHandledInbox({ myUserId, reactions, onLog }) {
  const items = pendingInbox.all(RECHECK_LIMIT + 1);
  const overflow = items.length > RECHECK_LIMIT;
  let retired = 0;

  for (const item of items.slice(0, RECHECK_LIMIT)) {
    let thread;
    try {
      thread = await slack.fetchThread(item.channel_id, item.thread_ts || item.message_ts);
    } catch {
      continue;   // deleted, or a scope we don't have; leave it in the inbox
    }
    const message = thread.find((m) => m.ts === item.message_ts);
    if (!message) continue;

    const signal = handledInSlack(message, { myUserId, reactions, messages: thread });
    if (!signal) continue;

    db.transaction(() => {
      retireInbox.run(item.id);
      markSeen.run(item.channel_id, item.message_ts, 'handled');
    })();
    retired++;
    onLog(`retired "${item.channel_name}" item — ${handledLabel(signal)}`);
  }

  if (overflow) {
    onLog(`re-checked the ${RECHECK_LIMIT} oldest triage items; more are waiting for the next sync`);
  }
  return retired;
}

/**
 * Thread timestamps I have posted in, for one channel.
 *
 * Derived from messages we have already fetched plus threads that previously
 * produced a task - deliberately no extra API call. An earlier version re-fetched
 * each channel's history here, which doubled the request count on every sync; on
 * a workspace with 170+ conversations that alone ran for minutes.
 */
function myThreadsFor(channelId, myUserId, fetchedMessages) {
  const set = new Set(
    db
      .prepare('SELECT DISTINCT thread_ts FROM tasks WHERE channel_id = ? AND thread_ts IS NOT NULL')
      .all(channelId)
      .map((r) => r.thread_ts)
  );
  for (const m of fetchedMessages) {
    if (m.user === myUserId) set.add(m.thread_ts ?? m.ts);
  }
  return set;
}

/**
 * Run one sync pass.
 *
 * `classifier` is injectable so tests can drive the loop without spawning the
 * CLI; production always uses the real batched call.
 *
 * @returns stats { channels, messages, candidates, llmCalls, inboxed, errors }
 */
export async function runSync({ onLog = () => {}, classifier = classifyBatch } = {}) {
  if (running) return { skipped: true, reason: 'already_running' };
  // Either source is enough to be worth a pass; each is skipped on its own.
  const slackOn = hasSlackToken();
  const mailOn = hasGmail();
  if (!slackOn && !mailOn) return { skipped: true, reason: 'no_token' };

  running = true;
  const runId = db
    .prepare('INSERT INTO sync_runs DEFAULT VALUES')
    .run().lastInsertRowid;

  const stats = {
    channels: 0, messages: 0, candidates: 0, llmCalls: 0, inboxed: 0, rejected: 0,
    catchingUp: 0, handled: 0, mirrored: 0, ephemeral: 0, social: 0, mail: 0, waiting: 0, errors: [],
  };

  try {
    if (slackOn) await refreshDirectories({ force: false });

    // auth.test returns the bot's ID on a bot token, which would make us watch
    // for mentions of the bot. The override wins whenever it is set.
    const myUserId = getSetting('slack_user_id_override')?.trim() || getSetting('slack_user_id');
    const teamUrl = getSetting('slack_team_domain');
    const timezone = getSetting('timezone');
    const model = getSetting('model');
    const batchSize = Number(getSetting('batch_size')) || 15;
    const minConfidence = Number(getSetting('min_confidence'));
    // 0 means "start from now" - a first run should not drag in weeks of old
    // conversation. Note `|| 7` would swallow a deliberate 0.
    const rawBackfill = Number(getSetting('backfill_days'));
    const backfillDays = Number.isFinite(rawBackfill) && rawBackfill >= 0 ? rawBackfill : 0;
    const aliasMatcher = buildAliasMatcher(getAliases());
    const autoRetire = getSetting('auto_retire_handled') !== 'false';
    const handledReactions = parseHandledReactions(getSetting('handled_reactions'));
    const priorityIds = new Set(priorityPeople.all().map((r) => r.slack_user_id));
    const watchPriorityPeople = getSetting('watch_priority_people') !== 'false';
    const people = new Map(
      db.prepare('SELECT slack_user_id, display_name FROM people').all().map((r) => [r.slack_user_id, r.display_name])
    );

    const backfillTs = slack.dateToTs(new Date(Date.now() - backfillDays * 86_400_000));
    const channels = slackOn ? selectActiveChannels.all() : [];
    const pendingCursors = new Map();   // channelId -> newest ts seen this run

    // ---- Steps 1-3: fetch and filter. No LLM. ----
    for (const channel of channels) {
      stats.channels++;
      const oldest = channel.last_synced_ts ?? backfillTs;

      try {
        const messages = await slack.fetchHistory(channel.id, { oldest });
        stats.messages += messages.length;

        // A channel with more history than one sync can pull is not an error -
        // the cursor advances to what we did read, so the next sync resumes
        // there. Counting it lets the UI say a backlog is still being worked
        // through rather than looking finished when it isn't.
        if (messages.truncated) stats.catchingUp++;

        const threadSet =
          channel.kind === 'channel' || channel.kind === 'private'
            ? myThreadsFor(channel.id, myUserId, messages)
            : new Set();

        // Replies live inside threads, so history alone misses them. Slack gives
        // us `latest_reply` on the parent, so we only spend a call on threads
        // that actually have activity newer than our cursor.
        const staleThreads = new Set();
        for (const m of messages) {
          if (m.latest_reply && Number(m.latest_reply) <= Number(oldest)) staleThreads.add(m.ts);
        }
        const threadsToFetch = [...threadSet].filter((t) => !staleThreads.has(t));

        const threadReplies = [];
        for (const parentTs of threadsToFetch) {
          try {
            threadReplies.push(...(await slack.fetchReplies(channel.id, parentTs, { oldest })));
          } catch {
            // thread may be deleted or inaccessible; skip it
          }
        }

        const all = [...messages, ...threadReplies];
        stats.mirrored += mirrorMyReplies(channel.id, myUserId, all);
        let newestTs = channel.last_synced_ts ?? null;

        for (const m of all) {
          if (!newestTs || Number(m.ts) > Number(newestTs)) newestTs = m.ts;
          if (seenStmt.get(channel.id, m.ts)) continue;

          const hit = classifyCandidate(m, {
            myUserId,
            channelKind: channel.kind,
            aliasMatcher,
            myThreadTs: threadSet,
            priorityUserIds: watchPriorityPeople ? priorityIds : null,
          });
          if (!hit) continue;

          // Something you ticked or answered in Slack is finished work, not a
          // decision waiting to be made - it never reaches triage. This is what
          // makes a wake-up backlog readable: the half you dealt with on your
          // phone drops out of it silently.
          if (autoRetire) {
            const signal = handledInSlack(m, {
              myUserId,
              reactions: handledReactions,
              messages: all,
            });
            if (signal) {
              markSeen.run(channel.id, m.ts, 'handled');
              stats.handled++;
              continue;
            }
          }

          // A reply in a thread that already produced a task updates it rather
          // than spawning a duplicate card.
          const threadTs = m.thread_ts ?? null;
          if (threadTs) {
            const existing = findTaskByThread.get(channel.id, threadTs);
            if (existing) {
              db.prepare("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?").run(existing.id);
              markSeen.run(channel.id, m.ts, 'merged');
              continue;
            }
          }

          stats.candidates++;

          // Straight to disk, before the model is any part of this. From here on
          // the message is safe: Claude can be asleep, logged out or rate
          // limited and the only thing that changes is when it gets judged.
          enqueueCandidate({
            id: `${channel.id}:${m.ts}`,
            channel: channel.name,
            channelId: channel.id,
            channelName: channel.name,
            messageTs: m.ts,
            threadTs,
            from: people.get(m.user) ?? m.user ?? 'unknown',
            assignerId: m.user ?? null,
            assignerName: people.get(m.user) ?? m.user ?? null,
            sentAt: slack.tsToDate(m.ts).toISOString(),
            text: m.text,
            files: m.files,              // for Slack-permalink link extraction
            attachments: m.attachments,
            reason: hit.reason,
            isBroadcast: hit.isBroadcast,
          });
          markSeen.run(channel.id, m.ts, 'queued');
        }

        // Safe to commit as soon as the channel is read: everything that matched
        // is already queued, so the cursor moving forward can no longer strand
        // an unclassified message.
        if (newestTs) pendingCursors.set(channel.id, newestTs);
      } catch (err) {
        stats.errors.push(`${channel.name}: ${err.message}`);
        onLog(`error in ${channel.name}: ${err.message}`);
      }
    }

    // ---- Email: same shape, second source. Still no LLM. ----
    //
    // Its failure is recorded and stepped over, never thrown: a lapsed Google
    // grant must not stop Slack from being read, or the queue from draining.
    let mailCursor = null;
    if (mailOn) {
      try {
        const mail = await collectMail({ onLog });
        stats.messages += mail.scanned;
        stats.mail = mail.scanned;
        stats.candidates += mail.candidates;
        stats.handled += mail.handled;
        if (mail.catchingUp) stats.catchingUp++;
        mailCursor = mail.cursor;
        if (mail.scanned) onLog(`${mail.scanned} email(s) read, ${mail.candidates} addressed to you`);
      } catch (err) {
        stats.errors.push(err.userMessage ?? 'Gmail could not be read; will retry.');
        onLog(`email sync failed: ${err.detail ?? err.message}`);
      }
    }

    // Items queued by an earlier sync may have been dealt with in Slack since.
    if (autoRetire && slackOn) {
      stats.handled += await retireHandledInbox({
        myUserId,
        reactions: handledReactions,
        onLog,
      });
    }

    onLog(
      `${stats.messages} messages scanned, ${stats.candidates} candidates` +
        (stats.handled ? `, ${stats.handled} already handled in Slack` : '') +
        (stats.catchingUp
          ? ` · ${stats.catchingUp} channel(s) still catching up, sync again to continue`
          : '')
    );

    // ---- Step 4: the only LLM work, batched, skipped entirely when empty. ----
    //
    // The queue is what gets classified, not just what this sync found. Messages
    // that arrived while Claude was unavailable — including everything caught
    // during a week the laptop was shut — are judged here, oldest first.
    const candidates = queuedCandidates(DRAIN_LIMIT);
    const backlog = queueStats().waiting;
    if (backlog > candidates.length) {
      onLog(`${backlog} messages waiting; judging the ${candidates.length} oldest this pass`);
    } else if (candidates.length > stats.candidates) {
      onLog(`${candidates.length - stats.candidates} message(s) held over from an earlier sync`);
    }

    const verdicts = new Map();
    const failedIds = new Set();

    for (const batch of chunk(candidates, batchSize)) {
      try {
        const result = await classifier(
          batch.map((c) => ({
            id: c.id,
            channel: c.channel,
            from: c.from,
            sentAt: c.sentAt,
            text: c.text,
            isBroadcast: c.isBroadcast,
            threadContext: c.threadContext,
            // Without this, an unaddressed "we need X done by Thursday" from
            // someone senior reads as ambiguous and scores below the confidence
            // floor - which is exactly the message the user wanted caught.
            fromPriorityPerson: priorityIds.has(c.assignerId),
          })),
          { model, timezone }
        );
        stats.llmCalls += result.calls;
        for (const [id, v] of result.verdicts) verdicts.set(id, v);
      } catch (err) {
        // Deliberately do NOT inbox unclassified messages. Dumping raw Slack
        // text onto the board buries the real tasks in noise. They simply stay
        // queued - with the reason recorded, so "nothing showed up today" can be
        // traced to a signed-out CLI instead of looking like Kent missed them.
        for (const c of batch) failedIds.add(c.id);
        markAttemptFailed(batch.map((c) => c.queueId), err.userMessage ?? err.message);
        // The terminal gets the cause; the recorded error stays human-readable
        // because it surfaces in the UI as the last sync's status.
        stats.errors.push(err.userMessage ?? 'Classification failed; will retry.');
        onLog(
          `classify failed for ${batch.length} message(s), still queued for the next sync: ${err.detail ?? err.message}`
        );
      }
    }
    stats.retrying = failedIds.size;

    // ---- Step 5: write to the triage inbox. ----
    const insertInbox = db.prepare(`
      INSERT INTO inbox_items
        (title, description, priority, due_date, category, is_broadcast, reason, confidence,
         channel_id, channel_name, message_ts, thread_ts, permalink,
         assigner_id, assigner_name, links, source_text, llm_verdict,
         source, sent_at, parent_task_id)
      VALUES
        (@title, @description, @priority, @dueDate, @category, @isBroadcast, @reason, @confidence,
         @channelId, @channelName, @messageTs, @threadTs, @permalink,
         @assignerId, @assignerName, @links, @sourceText, @llmVerdict,
         @source, @sentAt, @parentTaskId)
      ON CONFLICT(channel_id, message_ts) DO NOTHING
    `);

    for (const c of candidates) {
      if (failedIds.has(c.id)) continue;      // untouched, so the next sync retries it
      const verdict = verdicts.get(c.id) ?? null;

      // The model saying "not a task" is a real answer - respect it, and
      // remember it so the message never comes back. A low-confidence "task" is
      // treated the same way: the point of this tool is focus, and a hedged
      // guess costs more attention than it saves.
      if (verdict && (!verdict.isTask || verdict.confidence < minConfidence)) {
        settle(c, 'not_task');
        stats.rejected++;
        continue;
      }

      const card = enrich(
        { ...c, sentAt: new Date(c.sentAt) },
        verdict,
        { isPriorityPerson: priorityIds.has(c.assignerId), timezone }
      );

      // "can you join the call for 2 min?" is an ask, and the model sometimes
      // reads it as one - but it expired minutes after it was sent. A card for
      // it is pure noise, so it is dropped whatever the verdict said.
      if (looksEphemeral(c.text, { hasDeadline: Boolean(card.dueDate) })) {
        settle(c, 'not_task');
        stats.rejected++;
        stats.ephemeral++;
        continue;
      }

      // "how are you?" and "coming for lunch?" are addressed to you and are
      // still not work. Same backstop as above, for the same reason: the model
      // is told, and is occasionally polite enough to make a card anyway.
      if (looksSocial(c.text, { hasLinks: card.links.length > 0 })) {
        settle(c, 'not_task');
        stats.rejected++;
        stats.social++;
        continue;
      }

      // An email already carries the link to its own thread.
      const permalink = c.permalink ?? (await slack.getPermalink(c.channelId, c.messageTs, { teamUrl }));

      insertInbox.run({
        title: card.title,
        description: card.description,
        priority: card.priority,
        dueDate: card.dueDate,
        category: card.category,
        isBroadcast: card.isBroadcast,
        reason: card.reason,
        confidence: card.confidence,
        channelId: c.channelId,
        channelName: c.channelName,
        messageTs: c.messageTs,
        threadTs: c.threadTs,
        permalink,
        assignerId: c.assignerId,
        assignerName: c.assignerName,
        links: JSON.stringify(card.links),
        sourceText: c.text,
        llmVerdict: verdict ? JSON.stringify(verdict) : null,
        source: c.source ?? 'slack',
        sentAt: c.sentAt ?? null,
        parentTaskId: c.parentTaskId ?? null,
      });

      settle(c, 'inboxed');
      stats.inboxed++;
    }

    for (const [channelId, ts] of pendingCursors) setCursor.run(ts, channelId);
    if (mailCursor) setSetting('gmail_cursor', mailCursor);

    stats.waiting = queueStats().waiting;
    onLog(
      `${stats.inboxed} items queued for triage, ${stats.rejected} rejected as not-a-task` +
        (stats.ephemeral ? ` (${stats.ephemeral} already over by now)` : '') +
        (stats.social ? ` (${stats.social} social, not work)` : '') +
        `, ${stats.llmCalls} LLM call(s)` +
        (failedIds.size ? `, ${failedIds.size} still waiting on Claude` : '')
    );
  } catch (err) {
    stats.errors.push(err.message);
    onLog(`sync failed: ${err.message}`);
  } finally {
    db.prepare(
      `UPDATE sync_runs SET finished_at = datetime('now'), channels_seen = ?, messages_seen = ?,
       candidates = ?, llm_calls = ?, inboxed = ?, handled = ?, error = ? WHERE id = ?`
    ).run(
      stats.channels,
      stats.messages,
      stats.candidates,
      stats.llmCalls,
      stats.inboxed,
      stats.handled,
      stats.errors.length ? stats.errors.join('; ') : null,
      runId
    );
    running = false;
  }

  return stats;
}

// ------------------------------------------------------------- scheduling

const HEARTBEAT_MS = 30_000;
const CATCH_UP_DELAY_MS = 5_000;
const MAX_CATCH_UP_PASSES = 20;

let intervalMs = 15 * 60_000;
let nextRunAt = 0;
let catchUpPasses = 0;

const formatGap = (ms) => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

/**
 * One heartbeat: run if a sync is due.
 *
 * Everything hangs off wall-clock comparison rather than a timer firing on
 * schedule, because on a laptop it doesn't. Timers are frozen while the lid is
 * shut, so a run that was due at 3am simply shows up as overdue at 9am and
 * happens immediately.
 */
async function tick(onLog) {
  if (running || Date.now() < nextRunAt) return;

  const overdueBy = Date.now() - nextRunAt;
  if (nextRunAt > 0 && overdueBy > Math.max(intervalMs, 5 * 60_000)) {
    onLog(`back after ${formatGap(overdueBy + intervalMs)} away - catching up on Slack now`);
  }

  // Claim the next slot before awaiting, so a slow sync can't stack up runs.
  nextRunAt = Date.now() + intervalMs;

  try {
    const stats = await runSync({ onLog });
    const delay = nextSyncDelay({
      catchingUp: stats?.catchingUp ?? 0,
      backlog: stats?.waiting ?? 0,
      errors: stats?.errors?.length ?? 0,
      passes: catchUpPasses,
      intervalMs,
    });

    if (delay === CATCH_UP_DELAY_MS) {
      catchUpPasses++;
    } else {
      if (catchUpPasses >= MAX_CATCH_UP_PASSES) {
        onLog(`still catching up after ${MAX_CATCH_UP_PASSES} passes; resuming on the normal interval`);
      }
      catchUpPasses = 0;
    }
    nextRunAt = Date.now() + delay;
  } catch (e) {
    onLog(`scheduled sync error: ${e.message}`);
  }
}

/**
 * How long to wait before the next background sync, given how the last one went.
 *
 * Slack caps how much history one pass can pull, and the cursor advances to what
 * we did read. When a channel is still behind, come straight back rather than
 * draining a week of backlog one interval at a time — the whole point is that
 * waking the laptop costs you nothing. Bounded, so a channel that never finishes
 * catching up cannot turn into a hot loop against the Slack API.
 *
 * The same goes for the queue. One pass judges a capped number of messages, so
 * after a long absence Slack can be fully read while hundreds of captured
 * messages still wait on the model - and they used to wait a full interval per
 * batch. `backlog` only counts as a reason to hurry when the pass was clean:
 * with errors, what is waiting is waiting on Claude, and hurrying won't help.
 */
export function nextSyncDelay({ catchingUp = 0, backlog = 0, errors = 0, passes = 0, intervalMs }) {
  const behind = catchingUp > 0 || backlog > 0;
  const chasing = behind && errors === 0 && passes < MAX_CATCH_UP_PASSES;
  return chasing ? CATCH_UP_DELAY_MS : intervalMs;
}

/**
 * Start (or restart) background syncing.
 *
 * `runNow` makes opening the laptop - or restarting Kent - look at Slack
 * straight away instead of waiting out an interval that was already running when
 * the machine went to sleep.
 */
export function startScheduler({ onLog = console.log, runNow = true } = {}) {
  stopScheduler();
  if (getSetting('auto_sync') !== 'true') {
    onLog('auto-sync is off; use Sync now');
    return;
  }
  const minutes = Math.max(1, Number(getSetting('poll_interval_minutes')) || 15);
  intervalMs = minutes * 60_000;
  nextRunAt = runNow ? 0 : Date.now() + intervalMs;
  catchUpPasses = 0;

  timer = setInterval(() => { void tick(onLog); }, HEARTBEAT_MS);
  timer.unref?.();
  onLog(`auto-sync every ${minutes} min`);

  if (runNow) void tick(onLog);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  catchUpPasses = 0;
}

/** When the next background sync is due, for the UI. */
export const nextSyncAt = () => (timer ? new Date(nextRunAt).toISOString() : null);

export function lastSyncRun() {
  return db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() ?? null;
}
