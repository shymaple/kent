/**
 * The sync loop: fetch -> prefilter -> classify -> inbox.
 *
 * Cost shape: steps 1-3 are pure Slack + string matching. The model is only
 * invoked in step 4, and only when candidates exist. A sync over a quiet
 * workspace makes zero LLM calls.
 */
import { db, getAliases, getSetting, setSetting } from './db.js';
import { hasSlackToken } from './secrets.js';
import * as slack from './slack.js';
import { buildAliasMatcher, classifyCandidate } from './prefilter.js';
import { chunk, classifyBatch } from './classify.js';
import { enrich } from './enrich.js';

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
  if (!hasSlackToken()) return { skipped: true, reason: 'no_token' };

  running = true;
  const runId = db
    .prepare('INSERT INTO sync_runs DEFAULT VALUES')
    .run().lastInsertRowid;

  const stats = {
    channels: 0, messages: 0, candidates: 0, llmCalls: 0, inboxed: 0, rejected: 0,
    catchingUp: 0, errors: [],
  };

  try {
    await refreshDirectories({ force: false });

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
    const priorityIds = new Set(priorityPeople.all().map((r) => r.slack_user_id));
    const watchPriorityPeople = getSetting('watch_priority_people') !== 'false';
    const people = new Map(
      db.prepare('SELECT slack_user_id, display_name FROM people').all().map((r) => [r.slack_user_id, r.display_name])
    );

    const backfillTs = slack.dateToTs(new Date(Date.now() - backfillDays * 86_400_000));
    const channels = selectActiveChannels.all();
    const candidates = [];
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
          candidates.push({
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
        }

        // The cursor is only committed once this channel's candidates have been
        // classified - see below. Advancing it here would strand messages whose
        // classification failed.
        if (newestTs) pendingCursors.set(channel.id, newestTs);
      } catch (err) {
        stats.errors.push(`${channel.name}: ${err.message}`);
        onLog(`error in ${channel.name}: ${err.message}`);
      }
    }

    onLog(
      `${stats.messages} messages scanned, ${stats.candidates} candidates` +
        (stats.catchingUp
          ? ` · ${stats.catchingUp} channel(s) still catching up, sync again to continue`
          : '')
    );

    // ---- Step 4: the only LLM work, batched, skipped entirely when empty. ----
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
        // text onto the board buries the real tasks in noise. Instead we leave
        // these messages unseen and hold their channel cursor back, so the next
        // sync retries them once the CLI is healthy again.
        for (const c of batch) failedIds.add(c.id);
        stats.errors.push(`classify: ${err.message}`);
        onLog(`classify failed for ${batch.length} message(s), will retry next sync: ${err.message}`);
      }
    }
    stats.retrying = failedIds.size;

    // ---- Step 5: write to the triage inbox. ----
    const insertInbox = db.prepare(`
      INSERT INTO inbox_items
        (title, description, priority, due_date, category, is_broadcast, reason, confidence,
         channel_id, channel_name, message_ts, thread_ts, permalink,
         assigner_id, assigner_name, links, source_text, llm_verdict)
      VALUES
        (@title, @description, @priority, @dueDate, @category, @isBroadcast, @reason, @confidence,
         @channelId, @channelName, @messageTs, @threadTs, @permalink,
         @assignerId, @assignerName, @links, @sourceText, @llmVerdict)
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
        markSeen.run(c.channelId, c.messageTs, 'not_task');
        stats.rejected++;
        continue;
      }

      const card = enrich(
        { ...c, sentAt: new Date(c.sentAt) },
        verdict,
        { isPriorityPerson: priorityIds.has(c.assignerId), timezone }
      );

      const permalink = await slack.getPermalink(c.channelId, c.messageTs, { teamUrl });

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
      });

      markSeen.run(c.channelId, c.messageTs, 'inboxed');
      stats.inboxed++;
    }

    // Commit cursors last, and only for channels with nothing left to retry.
    const blocked = new Set(
      candidates.filter((c) => failedIds.has(c.id)).map((c) => c.channelId)
    );
    for (const [channelId, ts] of pendingCursors) {
      if (!blocked.has(channelId)) setCursor.run(ts, channelId);
    }

    onLog(
      `${stats.inboxed} items queued for triage, ${stats.rejected} rejected as not-a-task, ${stats.llmCalls} LLM call(s)` +
        (failedIds.size ? `, ${failedIds.size} held for retry` : '')
    );
  } catch (err) {
    stats.errors.push(err.message);
    onLog(`sync failed: ${err.message}`);
  } finally {
    db.prepare(
      `UPDATE sync_runs SET finished_at = datetime('now'), channels_seen = ?, messages_seen = ?,
       candidates = ?, llm_calls = ?, inboxed = ?, error = ? WHERE id = ?`
    ).run(
      stats.channels,
      stats.messages,
      stats.candidates,
      stats.llmCalls,
      stats.inboxed,
      stats.errors.length ? stats.errors.join('; ') : null,
      runId
    );
    running = false;
  }

  return stats;
}

/** Start (or restart) the background timer using the configured interval. */
export function startScheduler({ onLog = console.log } = {}) {
  stopScheduler();
  if (getSetting('auto_sync') !== 'true') {
    onLog('auto-sync is off; use Sync now');
    return;
  }
  const minutes = Math.max(1, Number(getSetting('poll_interval_minutes')) || 15);
  timer = setInterval(() => {
    runSync({ onLog }).catch((e) => onLog(`scheduled sync error: ${e.message}`));
  }, minutes * 60_000);
  timer.unref?.();
  onLog(`auto-sync every ${minutes} min`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function lastSyncRun() {
  return db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() ?? null;
}
