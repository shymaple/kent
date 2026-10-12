/**
 * API integration test: boots the real server against a temp database and
 * exercises the flow a user actually walks — inbox → approve → move stages →
 * comment → snooze → reorder.
 *
 * Covers the derived fields the board depends on (comment_count, replied,
 * can_reply, stale_days, is_snoozed), which unit tests can't see because they
 * are computed on the way out of the API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'kent-api-'));
const dbPath = join(dir, 'test.db');
const PORT = 4390 + Math.floor(process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

let server;

const api = async (path, options = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test.before(async () => {
  server = spawn('node', [join(here, 'index.js')], {
    env: { ...process.env, MYBOT_DB: dbPath, PORT: String(PORT), MYBOT_NO_KEYCHAIN: '1', SLACK_USER_TOKEN: '' },
    stdio: 'ignore',
  });

  // Wait for it to answer rather than guessing at a sleep duration.
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/lists`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
});

test.after(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

let taskId;

const isRecent = (iso) => Math.abs(Date.now() - Date.parse(iso)) < 60_000;

test('a task created from a Slack message can be replied to', async () => {
  // Seed a Slack-origin task directly; the sync path is covered elsewhere.
  const db = new Database(dbPath);
  const listId = db.prepare("SELECT id FROM lists WHERE semantic='backlog'").get().id;
  taskId = db.prepare(
    `INSERT INTO tasks (title, status, list_id, priority, links, channel_id, channel_name, message_ts, position)
     VALUES ('Review the deck', 'open', ?, 'high', '[]', 'C1', 'eng', '1700000000.000100', 1)`
  ).run(listId).lastInsertRowid;
  db.close();

  const { body } = await api('/api/tasks');
  const task = body.find((t) => t.id === taskId);
  assert.equal(task.can_reply, true, 'it has a thread to reply into');
  assert.equal(task.comment_count, 0);
  assert.equal(task.replied_in_slack, false);
  assert.equal(task.is_snoozed, false);
  assert.equal(task.stale_days, null, 'not stale while sitting in the backlog');
});

test('the card dates a Slack task by when the message was sent', async () => {
  const { body } = await api('/api/tasks');
  const task = body.find((t) => t.id === taskId);
  // Not when we synced it: the ts is the moment the ask actually landed.
  assert.equal(task.sent_at, new Date(1_700_000_000_000).toISOString());
  assert.equal(task.sent_at_source, 'slack');
});

test('a manual task cannot be replied to', async () => {
  const { body } = await api('/api/tasks', { method: 'POST', body: { title: 'Local only' } });
  assert.equal(body.can_reply, false, 'nothing to reply to, and the UI must know');
  // No Slack ts, so the card falls back to when it was typed in.
  assert.equal(isRecent(body.sent_at), true, `unexpected sent_at ${body.sent_at}`);
  assert.equal(body.sent_at_source, 'local');
});

test('comments show up on the card without opening it', async () => {
  await api(`/api/tasks/${taskId}/comments`, { method: 'POST', body: { body: 'Started on this' } });
  const { body } = await api('/api/tasks');
  const task = body.find((t) => t.id === taskId);
  assert.equal(task.comment_count, 1);
  assert.equal(task.replied_in_slack, false, 'logging is not replying');
});

test('idle only counts for work supposedly in flight', async () => {
  const db = new Database(dbPath);
  const active = db.prepare("SELECT id FROM lists WHERE semantic='active'").get().id;
  const backlog = db.prepare("SELECT id FROM lists WHERE semantic='backlog'").get().id;

  // Nine days untouched, but still in the backlog: a backlog item, not a stalled one.
  db.prepare("UPDATE tasks SET updated_at = datetime('now','-9 days') WHERE id = ?").run(taskId);
  let res = await api('/api/tasks');
  assert.equal(res.body.find((t) => t.id === taskId).stale_days, null);

  // Same age, now in progress: that is stalled.
  db.prepare("UPDATE tasks SET list_id = ?, updated_at = datetime('now','-9 days') WHERE id = ?")
    .run(active, taskId);
  res = await api('/api/tasks');
  assert.equal(res.body.find((t) => t.id === taskId).stale_days, 9);

  db.prepare('UPDATE tasks SET list_id = ? WHERE id = ?').run(backlog, taskId);
  db.close();
});

test('the idle threshold is configurable', async () => {
  const db = new Database(dbPath);
  const active = db.prepare("SELECT id FROM lists WHERE semantic='active'").get().id;
  db.prepare("UPDATE tasks SET list_id = ?, updated_at = datetime('now','-3 days') WHERE id = ?")
    .run(active, taskId);
  db.close();

  let res = await api('/api/tasks');
  assert.equal(res.body.find((t) => t.id === taskId).stale_days, null, '3 days is under the default 7');

  await api('/api/settings', { method: 'PUT', body: { stale_after_days: '2' } });
  res = await api('/api/tasks');
  assert.equal(res.body.find((t) => t.id === taskId).stale_days, 3, 'now over the threshold');

  await api('/api/settings', { method: 'PUT', body: { stale_after_days: '7' } });
});

test('snoozing hides a task until its date', async () => {
  let res = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { snooze_until: '2099-01-01' } });
  assert.equal(res.body.is_snoozed, true);

  res = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { snooze_until: null } });
  assert.equal(res.body.is_snoozed, false, 'unsnoozing brings it straight back');
});

test('a past snooze date is already expired', async () => {
  const res = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { snooze_until: '2020-01-01' } });
  assert.equal(res.body.is_snoozed, false, 'a date that has passed must not hide a task forever');
  await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { snooze_until: null } });
});

test('fractional positions let one card move without renumbering', async () => {
  const { body: a } = await api('/api/tasks', { method: 'POST', body: { title: 'A' } });
  const { body: b } = await api('/api/tasks', { method: 'POST', body: { title: 'B' } });
  assert.ok(b.position > a.position);

  // Drop B between nothing and A.
  const { body: moved } = await api(`/api/tasks/${b.id}`, {
    method: 'PATCH',
    body: { position: a.position - 1 },
  });
  assert.ok(moved.position < a.position, 'B now sorts before A');
});

test('moving into the done list stamps completion, moving out clears it', async () => {
  const { body: lists } = await api('/api/lists');
  const done = lists.find((l) => l.semantic === 'done');
  const backlog = lists.find((l) => l.semantic === 'backlog');

  let res = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { list_id: done.id } });
  assert.ok(res.body.completed_at, 'completion is stamped');
  assert.equal(res.body.status, 'completed');

  res = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { list_id: backlog.id } });
  assert.equal(res.body.completed_at, null, 'reopening clears it');
});

test('a column can be reordered wholesale', async () => {
  const { body: lists } = await api('/api/lists');
  const listId = lists.find((l) => l.semantic === 'review').id;

  const made = [];
  for (const title of ['One', 'Two', 'Three']) {
    const { body } = await api('/api/tasks', { method: 'POST', body: { title, list_id: listId } });
    made.push(body);
  }
  const [one, two, three] = made;

  // Drag the last card to the front.
  const res = await api(`/api/lists/${listId}/reorder`, {
    method: 'POST',
    body: { ids: [three.id, one.id, two.id] },
  });
  assert.equal(res.body.ordered, 3);

  const { body: after } = await api('/api/tasks');
  const column = after
    .filter((t) => t.list_id === listId)
    .sort((a, b) => a.position - b.position)
    .map((t) => t.title);
  assert.deepEqual(column, ['Three', 'One', 'Two']);
});

test('reordering does not count as touching the work', async () => {
  // Otherwise tidying the board would reset every idle counter on it.
  const { body: lists } = await api('/api/lists');
  const listId = lists.find((l) => l.semantic === 'review').id;
  const { body: before } = await api('/api/tasks');
  const target = before.find((t) => t.list_id === listId);

  await api(`/api/lists/${listId}/reorder`, { method: 'POST', body: { ids: [target.id] } });

  const { body: after } = await api('/api/tasks');
  assert.equal(
    after.find((t) => t.id === target.id).updated_at,
    target.updated_at,
    'updated_at must survive a reorder'
  );
});

test('a reorder cannot drag tasks out of another list', async () => {
  const { body: lists } = await api('/api/lists');
  const review = lists.find((l) => l.semantic === 'review').id;
  const backlog = lists.find((l) => l.semantic === 'backlog').id;

  const { body: before } = await api('/api/tasks');
  const outsider = before.find((t) => t.list_id === backlog);
  const positions = before.filter((t) => t.list_id === backlog).map((t) => [t.id, t.position]);

  // Passing a backlog id while reordering the review column must be ignored.
  await api(`/api/lists/${review}/reorder`, { method: 'POST', body: { ids: [outsider.id] } });

  const { body: after } = await api('/api/tasks');
  assert.equal(after.find((t) => t.id === outsider.id).list_id, backlog, 'it stayed put');
  assert.deepEqual(
    after.filter((t) => t.list_id === backlog).map((t) => [t.id, t.position]),
    positions,
    'and its column was left alone'
  );
});

test('reorder rejects nonsense', async () => {
  const { body: lists } = await api('/api/lists');
  const listId = lists[0].id;
  assert.equal((await api(`/api/lists/${listId}/reorder`, { method: 'POST', body: {} })).status, 400);
  assert.equal(
    (await api('/api/lists/99999/reorder', { method: 'POST', body: { ids: [1] } })).status,
    404
  );
});

test('approving the same inbox item twice makes one card', async () => {
  // A double click, or the Inbox open in two tabs.
  const db = new Database(dbPath);
  const itemId = db.prepare(
    `INSERT INTO inbox_items (title, priority, channel_id, channel_name, message_ts, source_text)
     VALUES ('Send the invoice', 'medium', 'C9', 'ops', '1700000900.000100', 'please send the invoice')`
  ).run().lastInsertRowid;
  db.close();

  const first = await api(`/api/inbox/${itemId}/approve`, { method: 'POST', body: {} });
  const second = await api(`/api/inbox/${itemId}/approve`, { method: 'POST', body: {} });
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);

  const { body } = await api('/api/tasks');
  assert.equal(body.filter((t) => t.title === 'Send the invoice').length, 1);
});

test('an inbox item approved with its title emptied keeps the original title', async () => {
  const db = new Database(dbPath);
  const itemId = db.prepare(
    `INSERT INTO inbox_items (title, priority, category, channel_id, channel_name, message_ts, source_text)
     VALUES ('Book the venue', 'medium', 'admin', 'C9', 'ops', '1700000901.000100', 'book the venue')`
  ).run().lastInsertRowid;
  db.close();

  const { body } = await api(`/api/inbox/${itemId}/approve`, {
    method: 'POST',
    body: { title: '   ', category: 'whatever I typed' },
  });
  assert.equal(body.title, 'Book the venue');
  assert.equal(body.category, 'admin', 'an unknown category must not be stored');
});

test('a half-typed date is refused instead of saved', async () => {
  // What a date input emits on the way to 2026 when typed by keyboard.
  const { status } = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { due_date: '0002-12-25' } });
  assert.equal(status, 400);

  const ok = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { due_date: '2026-12-25' } });
  assert.equal(ok.body.due_date, '2026-12-25');

  const cleared = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { due_date: null } });
  assert.equal(cleared.body.due_date, null);
});

test('a follow-up in a tracked thread is approved as a subtask, not a second card', async () => {
  const db = new Database(dbPath);
  const listId = db.prepare("SELECT id FROM lists WHERE semantic='done'").get().id;
  const parentId = db.prepare(
    `INSERT INTO tasks (title, status, list_id, priority, links, channel_id, channel_name, message_ts, thread_ts, source, sent_at, position)
     VALUES ('Send the renewal quote', 'completed', ?, 'medium', '[]', 'gmail', 'Email', 'm1', 'thread-1', 'email', '2026-08-07T06:40:00.000Z', 1)`
  ).run(listId).lastInsertRowid;
  const itemId = db.prepare(
    `INSERT INTO inbox_items (title, priority, channel_id, channel_name, message_ts, thread_ts, source_text, source, sent_at, parent_task_id)
     VALUES ('Send the updated DPA', 'medium', 'gmail', 'Email', 'm2', 'thread-1', 'Subject: Re: renewal', 'email', '2026-08-08T06:40:00.000Z', ?)`
  ).run(parentId).lastInsertRowid;
  db.close();

  const inbox = (await api('/api/inbox')).body.find((i) => i.id === itemId);
  assert.equal(inbox.parent_task_title, 'Send the renewal quote');
  assert.equal(inbox.source, 'email');
  assert.equal(inbox.sent_at, '2026-08-08T06:40:00.000Z', 'an email is dated by its own timestamp, not its id');

  const before = (await api('/api/tasks')).body.length;
  const { body } = await api(`/api/inbox/${itemId}/approve`, { method: 'POST', body: {} });

  assert.equal(body.id, parentId, 'the answer is the card it was added to');
  assert.equal(body.added_as_subtask, true);
  assert.equal(body.subtasks_open, 1);
  assert.equal(body.is_done, false, 'new work on a finished card reopens it');
  assert.equal(body.can_reply, false, 'Kent never writes email');
  assert.equal((await api('/api/tasks')).body.length, before, 'no second card');

  const subtasks = (await api(`/api/tasks/${parentId}/subtasks`)).body;
  assert.deepEqual(subtasks.map((s) => [s.title, s.source]), [['Send the updated DPA', 'email']]);
});

test('a follow-up whose card was deleted becomes an ordinary card', async () => {
  const db = new Database(dbPath);
  const itemId = db.prepare(
    `INSERT INTO inbox_items (title, priority, channel_id, channel_name, message_ts, source_text, source, parent_task_id)
     VALUES ('Orphaned follow-up', 'medium', 'gmail', 'Email', 'm3', 'Subject: x', 'email', 999999)`
  ).run().lastInsertRowid;
  db.close();

  const inbox = (await api('/api/inbox')).body.find((i) => i.id === itemId);
  assert.equal(inbox.parent_task_id, null, 'the Inbox must not promise a subtask it cannot add');

  const { body } = await api(`/api/inbox/${itemId}/approve`, { method: 'POST', body: {} });
  assert.equal(body.title, 'Orphaned follow-up');
  assert.equal(body.added_as_subtask, undefined);
});

test('connecting Gmail needs a real-looking client, and returns a consent URL with PKCE', async () => {
  const bad = await api('/api/gmail/connect', { method: 'POST', body: { client_id: 'nope', client_secret: 'x' } });
  assert.equal(bad.status, 400);

  const { status, body } = await api('/api/gmail/connect', {
    method: 'POST',
    body: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test' },
  });
  assert.equal(status, 200);
  const url = new URL(body.url);
  assert.equal(url.hostname, 'accounts.google.com');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly', 'read-only, nothing else');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('state').length >= 20);
  assert.ok(!body.url.includes('GOCSPX-test'), 'the secret never goes in a URL');

  assert.equal((await api('/api/gmail/status')).body.connected, false, 'nothing is stored until consent completes');
});

test('the consent return is refused without the state Kent issued', async () => {
  // Raw http, because fetch owns the Sec-Fetch-* headers and overwrites them.
  const navigate = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' };
  const status = (path, method = 'GET') =>
    new Promise((resolve, reject) => {
      const req = httpRequest(`${BASE}${path}`, { method, headers: navigate }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });

  assert.equal(
    await status('/api/gmail/callback?code=stolen&state=made-up'), 400,
    'reaches the handler, and is turned away there'
  );
  assert.equal((await api('/api/gmail/status')).body.connected, false);
  assert.equal(await status('/api/gmail/callback', 'POST'), 403, 'only a GET navigation is exempt');
  assert.equal(await status('/api/tasks'), 403, 'and only on that one path');
});

test('a hand-made task can say where it came from, and a Slack link makes it replyable', async () => {
  const { status, body } = await api('/api/tasks', {
    method: 'POST',
    body: {
      title: 'Follow up on the audit',
      permalink: 'https://acme.slack.com/archives/C0AUDIT01/p1720000000000200?thread_ts=1719999999.000100&cid=C0AUDIT01',
      assigner_name: '  Dana Cruz ',
      channel_name: '#compliance',
    },
  });

  assert.equal(status, 200);
  assert.equal(body.assigner_name, 'Dana Cruz');
  assert.equal(body.channel_name, 'compliance');
  assert.equal(body.channel_id, 'C0AUDIT01');
  assert.equal(body.message_ts, '1720000000.000200');
  assert.equal(body.thread_ts, '1719999999.000100');
  assert.equal(body.can_reply, true);
  assert.equal(body.sent_at_source, 'slack', 'dated by the message, not by when it was typed in');
});

test('a "Slack link" that is not a link to a Slack message is refused', async () => {
  for (const permalink of ['https://docs.google.com/document/d/abc', 'https://acme.slack.com/archives/C0AUDIT01', 'see slack']) {
    const { status, body } = await api('/api/tasks', { method: 'POST', body: { title: 'x', permalink } });
    assert.equal(status, 400, permalink);
    assert.ok(body.error.length > 20);
  }
});

test('importing from a link refuses anything that is not a Slack message link', async () => {
  const { status, body } = await api('/api/tasks/from-slack', {
    method: 'POST',
    body: { url: 'https://example.com/archives/C0AUDIT01/p1720000000000200' },
  });
  assert.equal(status, 400);
  assert.equal(body.code, 'not_slack');
});

test('a rich description is stored sanitised, with a plain rendering beside it', async () => {
  const { body } = await api(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    body: {
      description_html:
        '<div onclick="alert(1)">Check <b>the numbers</b><script>alert(1)</script></div><ul><li>see <a href="https://figma.com/file/x">the mock</a></li><li>and https://example.com/plain</li></ul>',
    },
  });

  assert.ok(!/script|onclick/.test(body.description_html));
  assert.match(body.description_html, /<b>the numbers<\/b>/);
  assert.equal(body.description, 'Check the numbers\n\n- see the mock\n- and https://example.com/plain');
});

test('links written in the description are listed on the task, apart from attachments', async () => {
  const db = new Database(dbPath);
  db.prepare('UPDATE tasks SET links = ? WHERE id = ?').run(
    JSON.stringify([
      { url: 'https://docs.google.com/document/d/abc', label: 'Deck' },
      { url: 'https://acme.slack.com/files/U1/F1/report.pdf', label: 'PDF · report.pdf' },   // saved before `kind` existed
      { url: 'https://acme.slack.com/files/U1/F2/data.csv', label: 'CSV · data.csv', kind: 'file' },
    ]),
    taskId
  );
  db.close();

  const task = (await api('/api/tasks')).body.find((t) => t.id === taskId);
  assert.deepEqual(task.attachments.map((a) => a.label), ['PDF · report.pdf', 'CSV · data.csv']);
  assert.deepEqual(task.links.map((l) => [l.url, l.label]), [
    ['https://docs.google.com/document/d/abc', 'Deck'],
    ['https://figma.com/file/x', 'the mock'],
    ['https://example.com/plain', 'Link'],
  ]);
});

test('saving a plain description clears the rich one, so they cannot disagree', async () => {
  const { body } = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { description: 'Just text now' } });
  assert.equal(body.description, 'Just text now');
  assert.equal(body.description_html, null);
});

test('the security guards are live on the running server', async () => {
  const res = await fetch(`${BASE}/api/tasks`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403, 'cross-origin requests are refused by the real server');
});
