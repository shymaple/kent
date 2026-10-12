/**
 * Subtasks, and the rule they exist to enforce: a task with a step still open
 * cannot be finished.
 *
 * Boots the real server, because the rule lives in the same PATCH every way of
 * closing a task goes through — a drag, the tick on the card, Mark done in the
 * dialog. Testing the route is what proves none of those can walk around it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'kent-subtasks-'));
const PORT = 4500 + Math.floor(process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let lists;
let taskId;

const api = async (path, options = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const listId = (semantic) => lists.find((l) => l.semantic === semantic).id;
const getTask = async () => (await api('/api/tasks')).body.find((t) => t.id === taskId);

test.before(async () => {
  server = spawn('node', [join(here, 'index.js')], {
    env: {
      ...process.env,
      MYBOT_DB: join(dir, 'test.db'),
      PORT: String(PORT),
      MYBOT_NO_KEYCHAIN: '1',
      SLACK_USER_TOKEN: '',
    },
    stdio: 'ignore',
  });

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/lists`);
      if (res.ok) {
        lists = await res.json();
        return;
      }
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

test('a new task has no subtasks and says so on the card', async () => {
  const { body } = await api('/api/tasks', { method: 'POST', body: { title: 'Ship the report' } });
  taskId = body.id;
  assert.equal(body.subtask_count, 0);
  assert.equal(body.subtasks_open, 0);
  assert.equal(body.is_done, false);
});

test('subtasks are added in order and counted on the card', async () => {
  await api(`/api/tasks/${taskId}/subtasks`, { method: 'POST', body: { title: 'Draft it' } });
  const { body } = await api(`/api/tasks/${taskId}/subtasks`, { method: 'POST', body: { title: '  Send it  ' } });

  assert.deepEqual(body.subtasks.map((s) => s.title), ['Draft it', 'Send it']);
  assert.equal(body.task.subtask_count, 2);
  assert.equal(body.task.subtasks_open, 2);
});

test('a subtask with no title is refused', async () => {
  const { status } = await api(`/api/tasks/${taskId}/subtasks`, { method: 'POST', body: { title: '   ' } });
  assert.equal(status, 400);
});

test('a task with an open subtask cannot be completed, and the refusal names what is open', async () => {
  const { status, body } = await api(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    body: { list_id: listId('done') },
  });

  assert.equal(status, 409);
  assert.equal(body.code, 'open_subtasks');
  assert.deepEqual(body.open_subtasks.map((s) => s.title), ['Draft it', 'Send it']);
  assert.equal((await getTask()).is_done, false, 'the task must not have moved');
});

test('the legacy status field cannot be used to walk around the rule', async () => {
  const { status } = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { status: 'completed' } });
  assert.equal(status, 409);
  assert.equal((await getTask()).is_done, false);
});

test('moving between unfinished lists is never blocked by subtasks', async () => {
  const { status, body } = await api(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    body: { list_id: listId('active') },
  });
  assert.equal(status, 200);
  assert.equal(body.list_id, listId('active'));
});

test('one subtask finished still leaves the task open', async () => {
  const [first] = (await api(`/api/tasks/${taskId}/subtasks`)).body;
  const { body } = await api(`/api/subtasks/${first.id}`, { method: 'PATCH', body: { done: true } });
  assert.equal(body.task.subtasks_open, 1);

  const { status, body: refusal } = await api(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    body: { list_id: listId('done') },
  });
  assert.equal(status, 409);
  assert.match(refusal.error, /Send it/, 'a single open subtask is named in the message itself');
});

test('once every subtask is finished the task completes', async () => {
  const open = (await api(`/api/tasks/${taskId}/subtasks`)).body.find((s) => !s.done);
  await api(`/api/subtasks/${open.id}`, { method: 'PATCH', body: { done: true } });

  const { status, body } = await api(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    body: { list_id: listId('done') },
  });
  assert.equal(status, 200);
  assert.equal(body.is_done, true);
  assert.ok(body.completed_at);
});

test('reopening a subtask on a finished task takes the task out of Completed', async () => {
  const [first] = (await api(`/api/tasks/${taskId}/subtasks`)).body;
  const { body } = await api(`/api/subtasks/${first.id}`, { method: 'PATCH', body: { done: false } });

  assert.equal(body.task.is_done, false);
  assert.equal(body.task.list_id, listId('active'));
  assert.equal(body.task.completed_at, null);
});

test('closing everything at once has to be asked for explicitly', async () => {
  const { status, body } = await api(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    body: { list_id: listId('done'), complete_subtasks: true },
  });
  assert.equal(status, 200);
  assert.equal(body.is_done, true);
  assert.equal(body.subtasks_open, 0);
});

test('adding a subtask to a finished task reopens it', async () => {
  const { body } = await api(`/api/tasks/${taskId}/subtasks`, {
    method: 'POST',
    body: { title: 'One more thing' },
  });
  assert.equal(body.task.is_done, false);
  assert.equal(body.task.subtasks_open, 1);
});

test('deleting the last open subtask unblocks the task', async () => {
  const open = (await api(`/api/tasks/${taskId}/subtasks`)).body.find((s) => !s.done);
  const { body } = await api(`/api/subtasks/${open.id}`, { method: 'DELETE' });
  assert.equal(body.task.subtasks_open, 0);

  const { status } = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { list_id: listId('done') } });
  assert.equal(status, 200);
});

test('deleting a task takes its subtasks with it', async () => {
  await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
  assert.deepEqual((await api(`/api/tasks/${taskId}/subtasks`)).body, []);
});
