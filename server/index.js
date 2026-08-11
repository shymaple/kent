import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  db, getSettings, setSettings, DEFAULT_SETTINGS,
  listIdForStatus, statusForList, isDoneList,
} from './db.js';
import { getSlackToken, hasSlackToken, maskToken, setSlackToken, clearSlackToken } from './secrets.js';
import * as slack from './slack.js';
import { lastSyncRun, refreshDirectories, runSync, startScheduler, isRunning } from './sync.js';
import { daysUntil, localDateString } from './enrich.js';
import { draftComment, summariseTone } from './classify.js';
import { renderSlackText, renderConversationName, invalidateDirectory } from './render.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = express();

/**
 * Kent listens on loopback with no login, which is fine for a local tool right
 * up until a web page you happen to have open starts talking to it. Two guards:
 *
 * 1. **Host allowlist** — blocks DNS rebinding, where an attacker's domain
 *    resolves to 127.0.0.1 so the browser treats their page as same-origin.
 * 2. **Origin check** — blocks CSRF. A cross-site POST with no body and no
 *    content-type is a "simple request", so it skips the CORS preflight and
 *    would otherwise reach us. `POST /api/comments/:id/send` posts to Slack and
 *    needs no body, so this was genuinely reachable from any open tab.
 *
 * Browsers always attach Origin to cross-origin requests, so allowlisting it is
 * enough; Sec-Fetch-Site is checked too where the browser provides it.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const isLoopbackHost = (value) => LOOPBACK.has(String(value).replace(/^\[|\]$/g, ''));

app.use((req, res, next) => {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  if (!isLoopbackHost(host)) {
    return res.status(403).json({ error: 'Kent only serves requests addressed to localhost.' });
  }

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let hostname = null;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      hostname = null;
    }
    if (!hostname || !isLoopbackHost(hostname)) {
      return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    }
  }

  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
  }

  next();
});

app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 4317;
const STATUSES = new Set(['open', 'in_progress', 'in_review', 'completed']);
const PRIORITIES = new Set(['high', 'medium', 'low']);

const commentStats = db.prepare(
  'SELECT COUNT(*) n, SUM(slack_ts IS NOT NULL) replied FROM comments WHERE task_id = ?'
);

/** Whole days since an ISO/SQLite timestamp, or null. */
function daysSince(stamp) {
  if (!stamp) return null;
  const t = Date.parse(stamp.includes('T') ? stamp : `${stamp.replace(' ', 'T')}Z`);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * Shape a task or inbox row for the client. Slack markup is rendered here so no
 * view can accidentally show a raw member id like <@U01ABC23DEF>.
 */
const parseTask = (row) => {
  const settings = getSettings();
  const base = {
    ...row,
    is_broadcast: Boolean(row.is_broadcast),
    links: JSON.parse(row.links || '[]'),
    title: renderSlackText(row.title),
    description: renderSlackText(row.description),
    source_text: renderSlackText(row.source_text),
    channel_name: renderConversationName(row.channel_name),
    days_until_due: daysUntil(row.due_date, settings.timezone),
  };

  // Only real tasks have comments; inbox rows share this shaper but have no id
  // in the tasks table.
  if (row.list_id === undefined) return base;

  const stats = commentStats.get(row.id) ?? { n: 0, replied: 0 };
  const list = db.prepare('SELECT semantic FROM lists WHERE id = ?').get(row.list_id);
  const idleDays = daysSince(row.updated_at);
  const threshold = Number(settings.stale_after_days) || 7;

  return {
    ...base,
    comment_count: stats.n,
    replied_in_slack: Boolean(stats.replied),
    can_reply: Boolean(row.channel_id && (row.thread_ts || row.message_ts)),
    // "Stale" only means something for work supposedly in flight - a card
    // sitting in Open is a backlog item, not a stalled one.
    stale_days: list?.semantic === 'active' && idleDays >= threshold ? idleDays : null,
    is_snoozed: Boolean(row.snooze_until && row.snooze_until > localDateString(new Date(), settings.timezone)),
  };
};

/** Wrap an async handler so a rejection becomes a clean 500 instead of a hang. */
const h = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(`[api] ${req.method} ${req.path}:`, err.message);
  res.status(500).json({ error: err.message });
});

// ---------------------------------------------------------------- settings

app.get('/api/settings', (req, res) => {
  const settings = getSettings();
  res.json({
    ...settings,
    aliases: JSON.parse(settings.aliases || '[]'),
    comment_templates: JSON.parse(settings.comment_templates || '[]'),
    slack_connected: hasSlackToken(),
    slack_token_masked: maskToken(getSlackToken()),
    defaults: DEFAULT_SETTINGS,
  });
});

app.put('/api/settings', (req, res) => {
  const allowed = [
    'poll_interval_minutes', 'backfill_days', 'model', 'timezone', 'batch_size', 'auto_sync',
    'slack_user_id_override', 'min_confidence', 'show_completed', 'show_miscellaneous',
    'watch_priority_people', 'stale_after_days', 'sort_mode',
  ];
  const patch = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  if (Array.isArray(req.body.aliases)) {
    patch.aliases = JSON.stringify(req.body.aliases.map((a) => String(a).trim()).filter(Boolean));
  }
  if (Array.isArray(req.body.comment_templates)) {
    patch.comment_templates = JSON.stringify(
      req.body.comment_templates.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
    );
  }
  setSettings(patch);
  startScheduler();                       // pick up a changed interval immediately
  res.json({ ok: true });
});

app.post('/api/slack/token', h(async (req, res) => {
  const token = String(req.body?.token ?? '').trim();
  if (!token) return res.status(400).json({ error: 'token is required' });

  // Validate before storing so a bad paste never overwrites a working token.
  let identity;
  try {
    identity = await slack.authTest({ token });
  } catch (err) {
    return res.status(400).json({
      error:
        err.code === 'invalid_auth'
          ? 'Slack rejected that token. Make sure the app is installed and you copied the whole token.'
          : `Slack rejected that token: ${err.code ?? err.message}`,
    });
  }

  setSlackToken(token);

  // A scope or token-type problem must not look like a connection failure:
  // the token IS stored, and we report exactly what is wrong.
  const health = await slack.diagnose();

  let channels = 0;
  let users = 0;
  try {
    const dirs = await refreshDirectories();
    channels = dirs.channels;
    users = dirs.users;
  } catch (err) {
    health.problems.push(`Could not load your channels: ${err.code ?? err.message}`);
  }

  res.json({ ok: true, connected: true, identity, channels, users, health });
}));

app.get('/api/slack/diagnose', h(async (req, res) => {
  res.json(await slack.diagnose());
}));

app.delete('/api/slack/token', (req, res) => {
  clearSlackToken();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- channels

app.get('/api/channels', (req, res) => {
  const settings = getSettings();
  const me = db
    .prepare('SELECT display_name FROM people WHERE slack_user_id = ?')
    .get(settings.slack_user_id_override?.trim() || settings.slack_user_id);
  // Group DM names embed everyone's handle; drop mine so the list reads cleanly.
  const myHandle = me?.display_name?.toLowerCase();

  res.json(
    db
      .prepare('SELECT * FROM channels WHERE is_member = 1')
      .all()
      .map((c) => ({
        ...c,
        name: renderConversationName(c, myHandle),
        raw_name: c.name,
        is_excluded: Boolean(c.is_excluded),
        is_member: Boolean(c.is_member),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  );
});

app.put('/api/channels/:id', (req, res) => {
  const excluded = req.body?.is_excluded ? 1 : 0;
  db.prepare('UPDATE channels SET is_excluded = ? WHERE id = ?').run(excluded, req.params.id);
  res.json({ ok: true });
});

app.post('/api/channels/refresh', h(async (req, res) => {
  const result = await refreshDirectories();
  invalidateDirectory();      // new names should render straight away
  res.json(result);
}));

// ---------------------------------------------------------------- people

app.get('/api/people', (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const rows = db.prepare('SELECT * FROM people ORDER BY is_priority DESC, display_name').all();
  const filtered = q
    ? rows.filter((p) => `${p.display_name} ${p.real_name ?? ''}`.toLowerCase().includes(q))
    : rows.filter((p) => p.is_priority);      // default view: just the priority list
  res.json(filtered.map((p) => ({ ...p, is_priority: Boolean(p.is_priority) })));
});

app.put('/api/people/:id', (req, res) => {
  db.prepare('UPDATE people SET is_priority = ? WHERE slack_user_id = ?')
    .run(req.body?.is_priority ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- inbox

app.get('/api/inbox', (req, res) => {
  res.json(
    db
      .prepare("SELECT * FROM inbox_items WHERE state = 'pending' ORDER BY created_at DESC, id DESC")
      .all()
      .map(parseTask)
  );
});

app.post('/api/inbox/:id/approve', (req, res) => {
  const item = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });

  // Edits made in the triage UI arrive in the body and win over the model's take.
  const edit = req.body ?? {};
  const merged = {
    title: edit.title ?? item.title,
    description: edit.description ?? item.description,
    priority: PRIORITIES.has(edit.priority) ? edit.priority : item.priority,
    due_date: edit.due_date !== undefined ? edit.due_date || null : item.due_date,
    category: edit.category ?? item.category,
  };

  const listId = listIdForStatus('open');
  const info = db.prepare(`
    INSERT INTO tasks
      (title, description, status, list_id, priority, due_date, category, is_broadcast, position,
       channel_id, channel_name, message_ts, thread_ts, permalink,
       assigner_id, assigner_name, links, source_text, confidence)
    VALUES
      (@title, @description, 'open', @list_id, @priority, @due_date, @category, @is_broadcast,
       (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE list_id = @list_id),
       @channel_id, @channel_name, @message_ts, @thread_ts, @permalink,
       @assigner_id, @assigner_name, @links, @source_text, @confidence)
  `).run({
    ...merged,
    list_id: listId,
    is_broadcast: item.is_broadcast,
    channel_id: item.channel_id,
    channel_name: item.channel_name,
    message_ts: item.message_ts,
    thread_ts: item.thread_ts,
    permalink: item.permalink,
    assigner_id: item.assigner_id,
    assigner_name: item.assigner_name,
    links: item.links,
    source_text: item.source_text,
    confidence: item.confidence,
  });

  db.prepare("UPDATE inbox_items SET state = 'approved' WHERE id = ?").run(item.id);
  res.json(parseTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid)));
});

app.post('/api/inbox/:id/dismiss', (req, res) => {
  const item = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE inbox_items SET state = 'dismissed' WHERE id = ?").run(item.id);
  db.prepare(`
    INSERT INTO seen_messages (channel_id, message_ts, outcome) VALUES (?, ?, 'dismissed')
    ON CONFLICT(channel_id, message_ts) DO UPDATE SET outcome = 'dismissed'
  `).run(item.channel_id, item.message_ts);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- lists

app.get('/api/lists', (req, res) => {
  res.json(db.prepare('SELECT * FROM lists ORDER BY position, id').all());
});

app.post('/api/lists', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const max = db.prepare('SELECT COALESCE(MAX(position), 0) p FROM lists').get().p;
  const info = db
    .prepare("INSERT INTO lists (name, position, semantic) VALUES (?, ?, 'custom')")
    .run(name.slice(0, 40), max + 1);
  res.json(db.prepare('SELECT * FROM lists WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/lists/:id', (req, res) => {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'not found' });

  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 40) : null;
  const position = req.body?.position !== undefined ? Number(req.body.position) : null;

  db.prepare('UPDATE lists SET name = ?, position = ? WHERE id = ?')
    .run(name || list.name, Number.isFinite(position) ? position : list.position, list.id);
  res.json(db.prepare('SELECT * FROM lists WHERE id = ?').get(list.id));
});

/**
 * Set the order of a whole column in one go.
 *
 * Taking the full id list and numbering it 1..n is far more robust than nudging
 * one card's position: no fractional drift, and the client's on-screen order
 * becomes the stored order exactly.
 */
app.post('/api/lists/:id/reorder', (req, res) => {
  const list = db.prepare('SELECT id FROM lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'not found' });

  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
  if (!ids?.length) return res.status(400).json({ error: 'ids array is required' });

  const update = db.prepare(
    "UPDATE tasks SET position = ?, updated_at = updated_at WHERE id = ? AND list_id = ?"
  );
  db.transaction(() => {
    ids.forEach((id, i) => update.run(i + 1, id, list.id));
  })();

  res.json({ ok: true, ordered: ids.length });
});

app.delete('/api/lists/:id', (req, res) => {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'not found' });

  const remaining = db
    .prepare('SELECT * FROM lists WHERE id != ? ORDER BY position, id')
    .all(list.id);
  if (!remaining.length) {
    return res.status(400).json({ error: 'the board needs at least one list' });
  }

  // Tasks move to the first surviving list - deleting a column must never
  // delete work. The client warns about this before calling.
  const target = remaining[0];
  const moved = db.transaction(() => {
    const n = db.prepare('SELECT COUNT(*) n FROM tasks WHERE list_id = ?').get(list.id).n;
    db.prepare('UPDATE tasks SET list_id = ?, status = ? WHERE list_id = ?')
      .run(target.id, statusForList(target.id), list.id);
    db.prepare('DELETE FROM lists WHERE id = ?').run(list.id);
    return n;
  })();

  res.json({ ok: true, moved, movedTo: target.name });
});

// ---------------------------------------------------------------- tasks

app.get('/api/tasks', (req, res) => {
  const includeArchived = req.query.archived === 'true';
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE (@archived = 1 OR archived_at IS NULL)
       ORDER BY status, position, id`
    )
    .all({ archived: includeArchived ? 1 : 0 });
  res.json(rows.map(parseTask));
});

app.post('/api/tasks', (req, res) => {
  const { title } = req.body ?? {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });

  const listExists = req.body.list_id
    && db.prepare('SELECT 1 FROM lists WHERE id = ?').get(req.body.list_id);
  const listId = listExists
    ? Number(req.body.list_id)
    : listIdForStatus(STATUSES.has(req.body.status) ? req.body.status : 'open');

  const info = db.prepare(`
    INSERT INTO tasks (title, description, status, list_id, priority, due_date, category, links, position)
    VALUES (@title, @description, @status, @list_id, @priority, @due_date, @category, '[]',
            (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE list_id = @list_id))
  `).run({
    title: String(title).trim(),
    description: req.body.description || null,
    status: statusForList(listId),
    list_id: listId,
    priority: PRIORITIES.has(req.body.priority) ? req.body.priority : 'medium',
    due_date: req.body.due_date || null,
    category: req.body.category || 'other',
  });
  res.json(parseTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid)));
});

app.patch('/api/tasks/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const patch = {};
  const body = req.body ?? {};
  if (body.title !== undefined) patch.title = String(body.title).trim() || task.title;
  if (body.description !== undefined) patch.description = body.description || null;
  if (body.due_date !== undefined) patch.due_date = body.due_date || null;
  if (body.category !== undefined) patch.category = body.category;
  if (body.snooze_until !== undefined) patch.snooze_until = body.snooze_until || null;
  if (body.position !== undefined) patch.position = Number(body.position);
  if (PRIORITIES.has(body.priority)) patch.priority = body.priority;

  // Moving between lists is the primary action; `status` is kept in step so the
  // Miscellaneous lane and any older rows stay consistent.
  if (body.list_id !== undefined && db.prepare('SELECT 1 FROM lists WHERE id = ?').get(body.list_id)) {
    patch.list_id = Number(body.list_id);
    patch.status = statusForList(patch.list_id);
    patch.completed_at = isDoneList(patch.list_id) ? new Date().toISOString() : null;
  } else if (STATUSES.has(body.status)) {
    patch.status = body.status;
    patch.list_id = listIdForStatus(body.status);
    patch.completed_at = body.status === 'completed' ? new Date().toISOString() : null;
  }
  if (body.archived !== undefined) patch.archived_at = body.archived ? new Date().toISOString() : null;

  const keys = Object.keys(patch);
  if (keys.length) {
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE tasks SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...patch, id: task.id });
  }
  res.json(parseTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)));
});

app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- comments

const getTask = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

app.get('/api/tasks/:id/comments', (req, res) => {
  res.json(db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY id').all(req.params.id));
});

app.post('/api/tasks/:id/comments', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const body = String(req.body?.body ?? '').trim();
  if (!body) return res.status(400).json({ error: 'comment body is required' });

  const kind = ['manual', 'generated', 'template'].includes(req.body?.kind) ? req.body.kind : 'manual';
  const info = db
    .prepare('INSERT INTO comments (task_id, body, kind) VALUES (?, ?, ?)')
    .run(task.id, body.slice(0, 3000), kind);
  res.json(db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/comments/:id', (req, res) => {
  db.prepare('DELETE FROM comments WHERE id = ? AND slack_ts IS NULL').run(req.params.id);
  res.json({ ok: true });
});

/** Draft 2-3 short replies. One model call, only when explicitly asked for. */
app.post('/api/tasks/:id/comment-draft', h(async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const intent = ['done', 'progress', 'blocked'].includes(req.body?.intent) ? req.body.intent : 'done';
  const settings = getSettings();
  try {
    const variants = await draftComment(task, intent, {
      model: settings.model,
      toneNote: settings.tone_note,
    });
    res.json({ variants });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

/**
 * Post a comment into the original Slack thread. Nothing here runs without an
 * explicit user action - the client always shows the text first.
 */
app.post('/api/comments/:id/send', h(async (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'not found' });
  if (comment.slack_ts) return res.status(409).json({ error: 'already sent' });

  const task = getTask(comment.task_id);
  if (!task?.channel_id || !(task.thread_ts || task.message_ts)) {
    return res.status(400).json({ error: 'this task has no Slack message to reply to' });
  }

  const threadTs = task.thread_ts || task.message_ts;
  let posted;
  try {
    posted = await slack.postThreadReply(task.channel_id, threadTs, comment.body);
  } catch (err) {
    return res.status(502).json({
      error:
        err.code === 'missing_scope'
          ? 'Slack needs the chat:write user scope. Add it to your app, reinstall, and re-paste the token.'
          : `Slack rejected the reply: ${err.code ?? err.message}`,
    });
  }

  const permalink = await slack.getPermalink(task.channel_id, posted.ts, {
    teamUrl: getSettings().slack_team_domain,
  });
  db.prepare("UPDATE comments SET slack_ts = ?, permalink = ?, posted_at = datetime('now') WHERE id = ?")
    .run(posted.ts, permalink, comment.id);

  res.json(db.prepare('SELECT * FROM comments WHERE id = ?').get(comment.id));
}));

/**
 * Learn the user's writing style from their own recent messages. Runs on demand
 * from Settings, one model call, and the result is cached in settings so
 * drafting a comment never pays for it again.
 */
app.post('/api/tone/learn', h(async (req, res) => {
  const settings = getSettings();
  const myUserId = settings.slack_user_id_override?.trim() || settings.slack_user_id;
  if (!myUserId) return res.status(400).json({ error: 'connect Slack first' });

  const channels = db
    .prepare("SELECT id FROM channels WHERE is_member = 1 AND is_excluded = 0 ORDER BY kind = 'im' DESC LIMIT 12")
    .all()
    .map((c) => c.id);

  const samples = await slack.sampleMyMessages(myUserId, channels, 30);
  if (samples.length < 5) {
    return res.status(400).json({
      error: `Only found ${samples.length} of your own messages to learn from. Try again once you have posted a bit more.`,
    });
  }

  const note = await summariseTone(samples, { model: settings.model });
  setSettings({ tone_note: note });
  res.json({ ok: true, tone_note: note, sampled: samples.length });
}));

app.delete('/api/tone', (req, res) => {
  setSettings({ tone_note: '' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- search

app.get('/api/search', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json([]);
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;

  // Local SQL only - searching your own board should never cost a model call.
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE archived_at IS NULL AND (
         title LIKE @like ESCAPE '\\' OR description LIKE @like ESCAPE '\\' OR
         source_text LIKE @like ESCAPE '\\' OR channel_name LIKE @like ESCAPE '\\' OR
         assigner_name LIKE @like ESCAPE '\\')
       ORDER BY
         CASE WHEN title LIKE @like ESCAPE '\\' THEN 0 ELSE 1 END,
         updated_at DESC
       LIMIT 30`
    )
    .all({ like });
  res.json(rows.map(parseTask));
});

// ---------------------------------------------------------------- sync

app.get('/api/sync/status', (req, res) => {
  const pending = db.prepare("SELECT COUNT(*) n FROM inbox_items WHERE state = 'pending'").get().n;
  res.json({
    running: isRunning(),
    connected: hasSlackToken(),
    inbox_pending: pending,
    last_run: lastSyncRun(),
  });
});

app.post('/api/sync/run', h(async (req, res) => {
  res.json(await runSync({ onLog: (m) => console.log(`[sync] ${m}`) }));
}));

// ---------------------------------------------------------------- client

const dist = join(root, 'client', 'dist');
if (existsSync(dist)) {
  // Asset filenames are content-hashed, so they can be cached hard. index.html
  // must never be, or a rebuilt app keeps serving the previous bundle to an
  // already-open tab - which is exactly what happened after the v2 build.
  app.use(
    express.static(dist, {
      etag: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );
  app.get(/^(?!\/api).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(join(dist, 'index.html'));
  });
} else {
  app.get('/', (req, res) =>
    res.status(503).send('Client not built. Run <code>npm run build</code>, or <code>npm run dev</code> for the dev server.')
  );
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Kent listening on http://localhost:${PORT}`);
  if (!hasSlackToken()) {
    console.log('No Slack token yet - open Settings in the app to connect. See SETUP.md.');
  }
  startScheduler({ onLog: (m) => console.log(`[sync] ${m}`) });
});
