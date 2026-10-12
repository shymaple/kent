import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  db, getSettings, setSettings, DEFAULT_SETTINGS,
  listIdForStatus, statusForList, isDoneList,
} from './db.js';
import {
  getSlackToken, hasSlackToken, maskToken, setSlackToken, clearSlackToken,
  clearGmailSecrets, hasGmail, setGmailSecrets,
} from './secrets.js';
import * as gmail from './gmail.js';
import * as slack from './slack.js';
import { lastSyncRun, nextSyncAt, refreshDirectories, runSync, startScheduler, isRunning } from './sync.js';
import { daysUntil, localDateString } from './enrich.js';
import { parseHandledReactions } from './handled.js';
import { queueStats } from './queue.js';
import { draftComment, summariseTone } from './classify.js';
import { renderSlackText, renderConversationName, invalidateDirectory } from './render.js';
import { extractLinks, isAttachment } from './prefilter.js';
import { htmlToText, linksInHtml, sanitizeHtml } from './richtext.js';
import { parseSlackLink } from './slacklink.js';
import { importSlackMessage } from './importslack.js';

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
 *
 * One request is expected to arrive cross-site: Google sending the browser back
 * after the Gmail consent screen. It is let through the Sec-Fetch-Site check
 * only as a top-level GET navigation to that exact path, and the handler then
 * refuses it unless it carries the one-time `state` Kent generated when the
 * user pressed Connect - the standard OAuth CSRF defence. A page that merely
 * links or redirects there has no valid state and changes nothing.
 */
const OAUTH_RETURN = '/api/gmail/callback';
const isOAuthReturn = (req) =>
  req.method === 'GET' && req.path === OAUTH_RETURN && req.headers['sec-fetch-mode'] === 'navigate';

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
  if (site && site !== 'same-origin' && site !== 'none' && !isOAuthReturn(req)) {
    return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
  }

  next();
});

app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 4317;
const STATUSES = new Set(['open', 'in_progress', 'in_review', 'completed']);
const PRIORITIES = new Set(['high', 'medium', 'low']);
const CATEGORIES = new Set(['bug', 'review', 'meeting', 'admin', 'doc', 'followup', 'other', 'broadcast']);

/**
 * A date the client sent, as something safe to store: null for "no date",
 * undefined for "that isn't one". The year floor is not pedantry - a date input
 * typed by keyboard passes through 0002 and 0020 on its way to 2026, and those
 * were being saved.
 */
function cleanDate(value) {
  if (value === null || value === '') return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) return undefined;
  return Number(text.slice(0, 4)) >= 2000 ? text : undefined;
}
const BAD_DATE = { error: "That date doesn't look right. Use the calendar, or type it as YYYY-MM-DD." };

const commentStats = db.prepare(
  'SELECT COUNT(*) n, SUM(slack_ts IS NOT NULL) replied FROM comments WHERE task_id = ?'
);
const subtaskStats = db.prepare(
  'SELECT COUNT(*) n, COALESCE(SUM(done = 0), 0) open FROM subtasks WHERE task_id = ?'
);

/** Whole days since an ISO/SQLite timestamp, or null. */
function daysSince(stamp) {
  if (!stamp) return null;
  const t = Date.parse(stamp.includes('T') ? stamp : `${stamp.replace(' ', 'T')}Z`);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * When the ask actually arrived, as an ISO instant.
 *
 * A Slack ts is epoch seconds with a microsecond suffix ("1720000000.000200"),
 * and it is the truthful answer: a message synced days later was still sent
 * when it was sent. Hand-made tasks have no ts, so they fall back to the row's
 * own creation time.
 */
function sentAt(row) {
  const seconds = Number.parseFloat(row.message_ts);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000).toISOString();
  const created = Date.parse(row.created_at?.includes('T') ? row.created_at : `${String(row.created_at ?? '').replace(' ', 'T')}Z`);
  return Number.isNaN(created) ? null : new Date(created).toISOString();
}

/**
 * Shape a task or inbox row for the client. Slack markup is rendered here so no
 * view can accidentally show a raw member id like <@U01ABC23DEF>.
 */
const parseTask = (row) => {
  const settings = getSettings();
  const isEmail = row.source === 'email';
  // Files someone uploaded and URLs someone wrote are different things to go
  // looking for, so they are listed apart. A link typed into the description
  // counts as a link on the task without anyone having to add it twice.
  const stored = JSON.parse(row.links || '[]');
  const links = new Map();
  for (const link of [
    ...stored.filter((l) => !isAttachment(l)),
    ...linksInHtml(row.description_html).map((l) => ({ ...l, label: l.label ?? undefined })),
    ...extractLinks(row.description ?? ''),
  ]) {
    const known = links.get(link.url);
    if (!known) links.set(link.url, { url: link.url, label: link.label ?? 'Link' });
    else if (known.label === 'Link' && link.label) known.label = link.label;
  }

  const base = {
    ...row,
    is_broadcast: Boolean(row.is_broadcast),
    links: [...links.values()],
    attachments: stored.filter(isAttachment),
    description_html: row.description_html ?? null,
    title: renderSlackText(row.title),
    description: renderSlackText(row.description),
    source_text: renderSlackText(row.source_text),
    channel_name: renderConversationName(row.channel_name),
    days_until_due: daysUntil(row.due_date, settings.timezone),
    // A Gmail id is not a timestamp the way a Slack ts is, so email rows carry
    // their own; reading the id as one dated every email to 1970.
    sent_at: row.sent_at ?? sentAt(row),
    // Lets the UI say "sent" for a Slack ask and "added" for a typed-in one.
    sent_at_source: isEmail ? 'email' : Number.parseFloat(row.message_ts) > 0 ? 'slack' : 'local',
    source: isEmail ? 'email' : row.channel_id ? 'slack' : 'manual',
  };

  // Only real tasks have comments; inbox rows share this shaper but have no id
  // in the tasks table.
  if (row.list_id === undefined) return base;

  const stats = commentStats.get(row.id) ?? { n: 0, replied: 0 };
  const steps = subtaskStats.get(row.id) ?? { n: 0, open: 0 };
  const list = db.prepare('SELECT semantic FROM lists WHERE id = ?').get(row.list_id);
  const idleDays = daysSince(row.updated_at);
  const threshold = Number(settings.stale_after_days) || 7;

  return {
    ...base,
    comment_count: stats.n,
    subtask_count: steps.n,
    subtasks_open: steps.open,
    is_done: list?.semantic === 'done',
    replied_in_slack: Boolean(stats.replied),
    // Kent reads mail and never writes it, so only a Slack task has a thread
    // it can reply into.
    can_reply: Boolean(!isEmail && row.channel_id && (row.thread_ts || row.message_ts)),
    // "Stale" only means something for work supposedly in flight - a card
    // sitting in Open is a backlog item, not a stalled one.
    stale_days: list?.semantic === 'active' && idleDays >= threshold ? idleDays : null,
    is_snoozed: Boolean(row.snooze_until && row.snooze_until > localDateString(new Date(), settings.timezone)),
  };
};

/**
 * Wrap an async handler so a rejection becomes a clean 500 instead of a hang.
 *
 * The full error goes to the terminal; the browser gets either a message we
 * wrote deliberately for a human (`userMessage`) or a generic line. Raw
 * internals — stack traces, SQL, shell command lines — are never worth showing
 * and tell an attacker more than they tell the user.
 */
const h = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(`[api] ${req.method} ${req.path}:`, err.detail ?? err.stack ?? err.message);
  res.status(500).json({
    error: err.userMessage ?? 'Something went wrong. Check the terminal running Kent for details.',
  });
});

// ---------------------------------------------------------------- settings

app.get('/api/settings', (req, res) => {
  const settings = getSettings();
  res.json({
    ...settings,
    aliases: JSON.parse(settings.aliases || '[]'),
    comment_templates: JSON.parse(settings.comment_templates || '[]'),
    handled_reactions: parseHandledReactions(settings.handled_reactions),
    slack_connected: hasSlackToken(),
    slack_token_masked: maskToken(getSlackToken()),
    defaults: DEFAULT_SETTINGS,
  });
});

app.put('/api/settings', (req, res) => {
  const allowed = [
    'poll_interval_minutes', 'backfill_days', 'model', 'timezone', 'batch_size', 'auto_sync',
    'slack_user_id_override', 'min_confidence', 'show_completed', 'show_miscellaneous',
    'watch_priority_people', 'stale_after_days', 'sort_mode', 'auto_retire_handled',
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
  // Pick up a changed interval immediately, but saving a setting is not a
  // reason to hit Slack - the next run stays on schedule.
  startScheduler({ runNow: false });
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

// ---------------------------------------------------------------- gmail

/**
 * Consent attempts in flight: state -> what is needed to finish the exchange.
 * In memory on purpose - a restart mid-consent should void the attempt - and
 * short-lived, so an abandoned one cannot be completed by someone else later.
 */
const pendingConsent = new Map();
const CONSENT_TTL_MS = 10 * 60_000;
const redirectUri = () => `http://127.0.0.1:${PORT}${OAUTH_RETURN}`;

app.get('/api/gmail/status', (req, res) => {
  res.json({
    connected: hasGmail(),
    address: hasGmail() ? getSettings().gmail_address || null : null,
    redirect_uri: redirectUri(),
  });
});

/** Step one: take the OAuth client, hand back the Google consent URL. */
app.post('/api/gmail/connect', (req, res) => {
  const clientId = String(req.body?.client_id ?? '').trim();
  const clientSecret = String(req.body?.client_secret ?? '').trim();
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'Both the client ID and the client secret are needed.' });
  }
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) {
    return res.status(400).json({
      error: 'That does not look like a Google OAuth client ID - it should end in .apps.googleusercontent.com.',
    });
  }

  for (const [key, value] of pendingConsent) {
    if (value.expires < Date.now()) pendingConsent.delete(key);
  }

  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  pendingConsent.set(state, { clientId, clientSecret, verifier, expires: Date.now() + CONSENT_TTL_MS });

  res.json({ url: gmail.buildAuthUrl({ clientId, redirectUri: redirectUri(), state, challenge }) });
});

/** A fixed page; nothing from the request is ever written into it. */
const consentPage = (heading, body) => `<!doctype html><meta charset="utf-8"><title>Kent</title>
<body style="font:15px/1.5 -apple-system,sans-serif;max-width:460px;margin:18vh auto;padding:0 20px;color:#1b1d23">
<h2 style="margin:0 0 8px">${heading}</h2><p style="color:#5c6270">${body}</p></body>`;

/** Step two: Google sends the browser back here with a one-time code. */
app.get(OAUTH_RETURN, h(async (req, res) => {
  const state = String(req.query.state ?? '');
  const pending = pendingConsent.get(state);
  pendingConsent.delete(state);

  if (!pending || pending.expires < Date.now()) {
    return res.status(400).send(consentPage(
      'That link is not valid',
      'Kent did not start this sign-in, or it expired. Go back to Settings in Kent and press Connect Gmail again.'
    ));
  }
  if (req.query.error || !req.query.code) {
    return res.status(400).send(consentPage(
      'Gmail was not connected',
      'Google did not grant access. Nothing was stored. You can close this tab and try again from Settings.'
    ));
  }

  try {
    const { refreshToken } = await gmail.exchangeCode({
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
      code: String(req.query.code),
      redirectUri: redirectUri(),
      verifier: pending.verifier,
    });
    setGmailSecrets({ clientId: pending.clientId, clientSecret: pending.clientSecret, refreshToken });
    const { address } = await gmail.getProfile();
    // A fresh connection starts from now, even if a previous one left a cursor.
    setSettings({ gmail_address: address, gmail_cursor: '' });
  } catch (err) {
    console.error('[api] gmail callback:', err.detail ?? err.message);
    clearGmailSecrets();
    gmail.resetAccess();
    return res.status(502).send(consentPage(
      'Gmail was not connected',
      'Google accepted the sign-in but Kent could not finish connecting. Check the terminal running Kent, then try again from Settings.'
    ));
  }

  res.send(consentPage(
    'Gmail is connected',
    'Kent will read new email from now on, read-only. You can close this tab and go back to Kent.'
  ));
}));

app.delete('/api/gmail', (req, res) => {
  clearGmailSecrets();
  gmail.resetAccess();
  setSettings({ gmail_address: '', gmail_cursor: '' });
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
      .prepare(
        // The card a follow-up would be added to. A parent that has since been
        // deleted comes back null, and approving then makes an ordinary card.
        `SELECT i.*, t.title AS parent_task_title FROM inbox_items i
         LEFT JOIN tasks t ON t.id = i.parent_task_id
         WHERE i.state = 'pending' ORDER BY i.created_at DESC, i.id DESC`
      )
      .all()
      .map((row) => ({ ...parseTask(row), parent_task_id: row.parent_task_title ? row.parent_task_id : null }))
  );
});

app.post('/api/inbox/:id/approve', (req, res) => {
  const item = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  // A double click, or the same Inbox open in two tabs, must not make two cards.
  if (item.state !== 'pending') {
    return res.status(409).json({ error: 'That item was already triaged.' });
  }

  // Edits made in the triage UI arrive in the body and win over the model's take.
  const edit = req.body ?? {};
  const due = edit.due_date !== undefined ? cleanDate(edit.due_date) : item.due_date;
  if (due === undefined) return res.status(400).json(BAD_DATE);
  const merged = {
    // An emptied title falls back rather than producing a blank card.
    title: String(edit.title ?? '').trim().slice(0, 120) || item.title,
    description: edit.description !== undefined ? String(edit.description).trim() || null : item.description,
    priority: PRIORITIES.has(edit.priority) ? edit.priority : item.priority,
    due_date: due,
    category: CATEGORIES.has(edit.category) ? edit.category : item.category,
  };

  // A new ask in a thread that already has a card becomes a step on that card.
  const parent = item.parent_task_id
    ? db.prepare('SELECT id FROM tasks WHERE id = ?').get(item.parent_task_id)
    : null;
  if (parent) {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO subtasks (task_id, title, source, source_ref, position)
        VALUES (@id, @title, @source, @ref,
                (SELECT COALESCE(MAX(position), 0) + 1 FROM subtasks WHERE task_id = @id))
      `).run({ id: parent.id, title: merged.title, source: item.source, ref: item.message_ts });
      db.prepare("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?").run(parent.id);
      reopenIfDone(parent.id);
      db.prepare("UPDATE inbox_items SET state = 'approved' WHERE id = ?").run(item.id);
    })();
    return res.json({
      ...parseTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(parent.id)),
      added_as_subtask: true,
    });
  }

  const listId = listIdForStatus('open');
  const taskId = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO tasks
        (title, description, status, list_id, priority, due_date, category, is_broadcast, position,
         channel_id, channel_name, message_ts, thread_ts, permalink,
         assigner_id, assigner_name, links, source_text, confidence, source, sent_at)
      VALUES
        (@title, @description, 'open', @list_id, @priority, @due_date, @category, @is_broadcast,
         (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE list_id = @list_id),
         @channel_id, @channel_name, @message_ts, @thread_ts, @permalink,
         @assigner_id, @assigner_name, @links, @source_text, @confidence, @source, @sent_at)
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
      source: item.source,
      sent_at: item.sent_at,
    });
    db.prepare("UPDATE inbox_items SET state = 'approved' WHERE id = ?").run(item.id);
    return info.lastInsertRowid;
  })();

  res.json(parseTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)));
});

app.post('/api/inbox/:id/dismiss', (req, res) => {
  const item = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (item.state !== 'pending') return res.status(409).json({ error: 'That item was already triaged.' });
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

  const due = cleanDate(req.body.due_date ?? null);
  if (due === undefined) return res.status(400).json(BAD_DATE);

  const listExists = req.body.list_id
    && db.prepare('SELECT 1 FROM lists WHERE id = ?').get(req.body.list_id);
  const listId = listExists
    ? Number(req.body.list_id)
    : listIdForStatus(STATUSES.has(req.body.status) ? req.body.status : 'open');

  // Where a hand-made task came from, if the user says. A Slack link has to be
  // a link to one message - then the card can be replied to and is dated by the
  // message, exactly like one Kent found itself.
  let origin = { channel_id: null, message_ts: null, thread_ts: null, permalink: null };
  if (String(req.body.permalink ?? '').trim()) {
    const link = parseSlackLink(req.body.permalink, { teamDomain: getSettings().slack_team_domain });
    if (!link.ok) return res.status(400).json({ error: link.error, code: link.code });
    origin = { channel_id: link.channelId, message_ts: link.ts, thread_ts: link.threadTs, permalink: link.url };
  }
  const knownChannel = origin.channel_id
    ? db.prepare('SELECT name FROM channels WHERE id = ?').get(origin.channel_id)?.name
    : null;
  const text = ({ value, max }) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max) || null;

  const html = req.body.description_html !== undefined ? sanitizeHtml(req.body.description_html) : null;

  const info = db.prepare(`
    INSERT INTO tasks
      (title, description, description_html, status, list_id, priority, due_date, category, links, position,
       channel_id, channel_name, message_ts, thread_ts, permalink, assigner_name)
    VALUES
      (@title, @description, @description_html, @status, @list_id, @priority, @due_date, @category, '[]',
       (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE list_id = @list_id),
       @channel_id, @channel_name, @message_ts, @thread_ts, @permalink, @assigner_name)
  `).run({
    ...origin,
    channel_name: text({ value: req.body.channel_name, max: 80 })?.replace(/^#/, '') ?? knownChannel ?? null,
    assigner_name: text({ value: req.body.assigner_name, max: 80 }),
    title: String(title).trim().slice(0, 120),
    description_html: html,
    description: html ? htmlToText(html) : String(req.body.description ?? '').trim() || null,
    status: statusForList(listId),
    list_id: listId,
    priority: PRIORITIES.has(req.body.priority) ? req.body.priority : 'medium',
    due_date: due,
    category: CATEGORIES.has(req.body.category) ? req.body.category : 'other',
  });
  // A sync that would also have caught that message must not offer it again.
  if (origin.channel_id) {
    db.prepare(`
      INSERT INTO seen_messages (channel_id, message_ts, outcome) VALUES (?, ?, 'inboxed')
      ON CONFLICT(channel_id, message_ts) DO NOTHING
    `).run(origin.channel_id, origin.message_ts);
  }
  res.json(parseTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid)));
});

/**
 * Create a task from nothing but a link to a Slack message. One model call,
 * made because the user asked - never part of a sync.
 */
app.post('/api/tasks/from-slack', async (req, res) => {
  try {
    const { task, phrasedByModel } = await importSlackMessage(req.body?.url, { listId: req.body?.list_id });
    res.json({ ...parseTask(task), phrased_by_model: phrasedByModel });
  } catch (err) {
    if (!err.status) console.error('[api] from-slack:', err.detail ?? err.stack ?? err.message);
    res.status(err.status ?? 500).json({
      error: err.userMessage ?? 'Something went wrong. Check the terminal running Kent for details.',
      code: err.code,
      ...(err.taskId ? { task_id: err.taskId } : {}),
    });
  }
});

app.patch('/api/tasks/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const patch = {};
  const body = req.body ?? {};
  if (body.title !== undefined) patch.title = String(body.title).trim() || task.title;
  if (body.description_html !== undefined) {
    // Stored only after being rebuilt from the allowlist; the plain rendering
    // is what search, the card and the reply drafter read.
    patch.description_html = sanitizeHtml(body.description_html);
    patch.description = patch.description_html ? htmlToText(patch.description_html) : null;
  } else if (body.description !== undefined) {
    patch.description = String(body.description ?? '').trim() || null;
    patch.description_html = null;
  }
  for (const key of ['due_date', 'snooze_until']) {
    if (body[key] === undefined) continue;
    const date = cleanDate(body[key]);
    if (date === undefined) return res.status(400).json(BAD_DATE);
    patch[key] = date;
  }
  if (CATEGORIES.has(body.category)) patch.category = body.category;
  if (Number.isFinite(Number(body.position)) && body.position !== null && body.position !== undefined) {
    patch.position = Number(body.position);
  }
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

  // A task with a step still open is not finished, however it is being closed -
  // dragged, ticked on the card, or marked done in the dialog. The caller gets
  // the open steps back so it can name them, and may close them all in the same
  // breath by saying so explicitly.
  const finishing = patch.list_id !== undefined && isDoneList(patch.list_id) && !isDoneList(task.list_id);
  const open = finishing ? openSubtasks.all(task.id) : [];
  if (open.length && body.complete_subtasks !== true) {
    return res.status(409).json({
      code: 'open_subtasks',
      open_subtasks: open,
      error:
        open.length === 1
          ? `One subtask is still open: “${open[0].title}”. Close it first.`
          : `${open.length} subtasks are still open. Close them first.`,
    });
  }

  const keys = Object.keys(patch);
  db.transaction(() => {
    if (open.length) finishSubtasks.run(task.id);
    if (keys.length) {
      const sets = keys.map((k) => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE tasks SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
        .run({ ...patch, id: task.id });
    }
  })();
  res.json(parseTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)));
});

app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- subtasks

const openSubtasks = db.prepare(
  'SELECT id, title FROM subtasks WHERE task_id = ? AND done = 0 ORDER BY position, id'
);
const finishSubtasks = db.prepare(
  "UPDATE subtasks SET done = 1, done_at = datetime('now') WHERE task_id = ? AND done = 0"
);
const subtasksFor = db.prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY position, id');
const parseSubtask = (row) => ({ ...row, done: Boolean(row.done) });

/**
 * A finished task that gains an open step is no longer finished. Moving it back
 * keeps the one promise the Completed column makes - nothing in it is waiting on
 * you - instead of leaving a "done" card with work quietly attached.
 */
function reopenIfDone(taskId) {
  const task = db.prepare('SELECT list_id FROM tasks WHERE id = ?').get(taskId);
  if (!task || !isDoneList(task.list_id)) return;
  const listId = listIdForStatus('in_progress');
  if (!listId || isDoneList(listId)) return;
  db.prepare(`
    UPDATE tasks SET list_id = @listId, status = @status, completed_at = NULL,
      position = (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE list_id = @listId),
      updated_at = datetime('now')
    WHERE id = @id
  `).run({ listId, status: statusForList(listId), id: taskId });
}

/** Every subtask write answers with the steps and the card, so counters can't drift. */
const subtaskReply = (taskId) => ({
  subtasks: subtasksFor.all(taskId).map(parseSubtask),
  task: parseTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)),
});

app.get('/api/tasks/:id/subtasks', (req, res) => {
  res.json(subtasksFor.all(req.params.id).map(parseSubtask));
});

app.post('/api/tasks/:id/subtasks', (req, res) => {
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const title = String(req.body?.title ?? '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'A subtask needs a title.' });

  db.transaction(() => {
    db.prepare(`
      INSERT INTO subtasks (task_id, title, position)
      VALUES (@id, @title, (SELECT COALESCE(MAX(position), 0) + 1 FROM subtasks WHERE task_id = @id))
    `).run({ id: task.id, title });
    db.prepare("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?").run(task.id);
    reopenIfDone(task.id);
  })();
  res.json(subtaskReply(task.id));
});

app.patch('/api/subtasks/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const body = req.body ?? {};
  const title = body.title !== undefined ? String(body.title).trim().slice(0, 200) || row.title : row.title;
  const done = body.done !== undefined ? (body.done ? 1 : 0) : row.done;

  db.transaction(() => {
    db.prepare(`
      UPDATE subtasks SET title = ?, done = ?,
        done_at = CASE WHEN ? = 1 THEN COALESCE(done_at, datetime('now')) ELSE NULL END
      WHERE id = ?
    `).run(title, done, done, row.id);
    db.prepare("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?").run(row.task_id);
    if (!done) reopenIfDone(row.task_id);
  })();
  res.json(subtaskReply(row.task_id));
});

app.delete('/api/subtasks/:id', (req, res) => {
  const row = db.prepare('SELECT task_id FROM subtasks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM subtasks WHERE id = ?').run(req.params.id);
  res.json(subtaskReply(row.task_id));
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
    console.error('[api] comment-draft:', err.detail ?? err.message);
    res.status(502).json({
      error: err.userMessage ?? 'Could not draft a reply just now. Please try again.',
    });
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
    // Either source is enough for Kent to have something to do.
    connected: hasSlackToken() || hasGmail(),
    inbox_pending: pending,
    last_run: lastSyncRun(),
    next_run_at: nextSyncAt(),
    // Messages captured but not yet judged. Never silently zero: if Claude is
    // signed out, this is the difference between "quiet day" and "nothing has
    // been looked at since Tuesday".
    awaiting_model: queueStats(),
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
