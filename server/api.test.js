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

test('a manual task cannot be replied to', async () => {
  const { body } = await api('/api/tasks', { method: 'POST', body: { title: 'Local only' } });
  assert.equal(body.can_reply, false, 'nothing to reply to, and the UI must know');
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

test('the security guards are live on the running server', async () => {
  const res = await fetch(`${BASE}/api/tasks`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403, 'cross-origin requests are refused by the real server');
});
