/**
 * Comment drafting and the Slack reply path.
 *
 * The guarantee that matters most: nothing reaches Slack without an explicit
 * send, and a comment is always logged locally either way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mybot-comments-'));
process.env.MYBOT_DB = join(dir, 'test.db');
process.env.SLACK_USER_TOKEN = 'xoxp-test';
process.env.MYBOT_NO_KEYCHAIN = '1';

const { db, listIdForStatus } = await import('./db.js');
const slack = await import('./slack.js');
const { parseJsonArray } = await import('./classify.js');

const taskId = db
  .prepare(
    `INSERT INTO tasks (title, status, list_id, priority, links, channel_id, message_ts, thread_ts)
     VALUES ('Review the deck', 'open', ?, 'medium', '[]', 'C1', '1700000000.000100', NULL)`
  )
  .run(listIdForStatus('open')).lastInsertRowid;

test('a comment is logged locally and is not sent by itself', () => {
  const info = db
    .prepare("INSERT INTO comments (task_id, body, kind) VALUES (?, 'Reviewed the deck', 'generated')")
    .run(taskId);
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid);

  assert.equal(comment.body, 'Reviewed the deck');
  assert.equal(comment.kind, 'generated');
  assert.equal(comment.slack_ts, null, 'logging must never imply sending');
  assert.equal(comment.posted_at, null);
});

test('comments are removed with their task', () => {
  const tmpTask = db
    .prepare("INSERT INTO tasks (title, status, list_id, links) VALUES ('temp', 'open', ?, '[]')")
    .run(listIdForStatus('open')).lastInsertRowid;
  db.prepare("INSERT INTO comments (task_id, body) VALUES (?, 'orphan risk')").run(tmpTask);

  db.prepare('DELETE FROM tasks WHERE id = ?').run(tmpTask);
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM comments WHERE task_id = ?').get(tmpTask).n,
    0,
    'cascade should leave no orphaned comments'
  );
});

test('postThreadReply targets the thread and asks Slack not to unfurl', async () => {
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { method: String(url).split('/api/')[1], params: new URLSearchParams(init.body) };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true, ts: '1700000500.000200', channel: 'C1' }),
    };
  };

  const result = await slack.postThreadReply('C1', '1700000000.000100', 'Reviewed the deck');

  assert.equal(sent.method, 'chat.postMessage');
  assert.equal(sent.params.get('channel'), 'C1');
  assert.equal(sent.params.get('thread_ts'), '1700000000.000100', 'must reply in-thread, not top level');
  assert.equal(sent.params.get('text'), 'Reviewed the deck');
  assert.equal(sent.params.get('unfurl_links'), 'false');
  assert.equal(result.ts, '1700000500.000200');
});

test('a missing chat:write scope surfaces as missing_scope, not a crash', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ ok: false, error: 'missing_scope', needed: 'chat:write', provided: 'channels:history' }),
  });

  await assert.rejects(
    () => slack.postThreadReply('C1', '1700000000.000100', 'hello'),
    (err) => {
      assert.equal(err.code, 'missing_scope');
      assert.deepEqual(err.needed, ['chat:write']);
      return true;
    }
  );
});

test('diagnose reports chat:write as optional, not as broken setup', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (h) =>
        h.toLowerCase() === 'x-oauth-scopes' ? Object.keys(slack.REQUIRED_SCOPES).join(',') : null,
    },
    json: async () => ({ ok: true, user: 'me', user_id: 'U0ME', team: 'acme', url: 'https://x.slack.com/' }),
  });

  const health = await slack.diagnose();
  assert.equal(health.ok, true, 'a read-only install is still a healthy install');
  assert.deepEqual(health.missingScopes, []);
  assert.deepEqual(health.missingOptional, ['chat:write']);
  assert.equal(health.canReply, false);
});

test('draft output parsing accepts a plain array of strings', () => {
  const variants = parseJsonArray('["Reviewed the deck.","Done — deck reviewed.","Deck review is finished."]');
  assert.equal(variants.length, 3);
  assert.equal(typeof variants[0], 'string');
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
