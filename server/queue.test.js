/**
 * Nothing is lost while the model is unavailable.
 *
 * The scenario is the real one: the laptop is shut, or Claude Code is signed
 * out, and Slack keeps going. Mentions must be captured anyway, survive any
 * number of failed syncs and a restart, and be judged whenever the model comes
 * back — without Slack having to hand them over a second time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kent-queue-'));
process.env.MYBOT_DB = join(dir, 'test.db');
process.env.SLACK_USER_TOKEN = 'xoxp-test';
process.env.MYBOT_NO_KEYCHAIN = '1';

const { db, setSetting } = await import('./db.js');
const { runSync } = await import('./sync.js');
const { queueStats } = await import('./queue.js');

const ME = 'U0ME';
const NOW = Math.floor(Date.now() / 1000);
const ts = (offset) => (NOW + offset).toFixed(6);

const ASK_ONE = ts(-900);
const ASK_TWO = ts(-800);
const ASK_LATE = ts(-100);
const ASK_EPHEMERAL = ts(-50);

let history = [
  { user: 'U1', text: `<@${ME}> please review the pricing deck`, ts: ASK_ONE },
  { user: 'U1', text: `<@${ME}> can you fix the login bug`, ts: ASK_TWO },
];

globalThis.fetch = async (url, init) => {
  const method = String(url).split('/api/')[1];
  const params = new URLSearchParams(init.body);
  const reply = (obj) => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ ok: true, ...obj }) });

  switch (method) {
    case 'auth.test':
      return reply({ user_id: ME, user: 'me', team_id: 'T1', team: 'Test', url: 'https://test.slack.com/' });
    case 'users.conversations':
      return reply({ channels: [{ id: 'C1', name: 'eng' }] });
    case 'users.list':
      return reply({ members: [{ id: 'U1', profile: { display_name: 'Alex', real_name: 'Alex N' }, name: 'alex' }] });
    case 'conversations.history': {
      const oldest = Number(params.get('oldest') || 0);
      return reply({ messages: history.filter((m) => Number(m.ts) > oldest), has_more: false });
    }
    case 'conversations.replies':
      return reply({ messages: [] });
    case 'chat.getPermalink':
      return reply({ permalink: `https://test.slack.com/archives/C1/p${params.get('message_ts').replace('.', '')}` });
    default:
      return reply({});
  }
};

/** A model that says yes to everything, so the deterministic rules are exposed. */
const eagerClassifier = async (candidates) => ({
  calls: 1,
  raw: '[]',
  verdicts: new Map(
    candidates.map((c) => [
      c.id,
      { id: c.id, isTask: true, title: `Task: ${c.text.slice(0, 20)}`, priority: 'medium', confidence: 0.9 },
    ])
  ),
});

const offline = () => {
  const err = new Error('claude CLI failed: not logged in');
  err.userMessage = 'Claude Code is not signed in. Run `claude` in a terminal and log in.';
  throw err;
};

const queued = () => db.prepare('SELECT * FROM pending_candidates ORDER BY sent_at').all();
const pending = () => db.prepare("SELECT * FROM inbox_items WHERE state='pending'").all();

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('mentions are captured even with no model at all', async () => {
  setSetting('timezone', 'UTC');
  setSetting('backfill_days', '7');

  const stats = await runSync({ classifier: offline });

  assert.equal(stats.candidates, 2, 'both mentions matched');
  assert.equal(stats.inboxed, 0, 'nothing is triaged on a guess');
  assert.equal(queued().length, 2, 'both are on disk, waiting for judgement');
  assert.equal(stats.waiting, 2);

  // The user-facing reason is kept, so a silent inbox can be explained.
  assert.match(queueStats().last_error, /not signed in/);
});

test('a second failed sync does not duplicate them', async () => {
  await runSync({ classifier: offline });

  const rows = queued();
  assert.equal(rows.length, 2, 'still two, not four');
  assert.deepEqual(rows.map((r) => r.attempts), [2, 2], 'each attempt is counted');
});

test('messages that arrive during the outage are captured too', async () => {
  history = [...history, { user: 'U1', text: `<@${ME}> update the runbook by tomorrow`, ts: ASK_LATE }];

  const stats = await runSync({ classifier: offline });
  assert.equal(stats.candidates, 1, 'only the new one is new');
  assert.equal(queued().length, 3);
  assert.equal(stats.waiting, 3);
});

test('a restart loses nothing - the queue is on disk, not in memory', async () => {
  // A fresh connection to the same file is exactly what a restarted Kent sees.
  const { default: Database } = await import('better-sqlite3');
  const reopened = new Database(process.env.MYBOT_DB, { readonly: true });
  const rows = reopened.prepare('SELECT text FROM pending_candidates ORDER BY sent_at').all();
  reopened.close();

  assert.equal(rows.length, 3);
  assert.match(rows[0].text, /pricing deck/);
});

test('the backlog is judged the moment the model answers again', async () => {
  history = [...history, { user: 'U1', text: `<@${ME}> can you join the meeting for 2 minutes?`, ts: ASK_EPHEMERAL }];

  const stats = await runSync({ classifier: eagerClassifier });

  assert.equal(stats.errors.length, 0, stats.errors.join('; '));
  assert.equal(stats.inboxed, 3, 'the three real asks, days late but not lost');
  assert.equal(stats.waiting, 0, 'the queue is empty again');
  assert.equal(queued().length, 0);

  const texts = pending().map((i) => i.source_text);
  assert.ok(texts.some((t) => t.includes('pricing deck')));
  assert.ok(texts.some((t) => t.includes('login bug')));
  assert.ok(texts.some((t) => t.includes('runbook')));
});

test('an ask that expired before you read it never reaches triage', async () => {
  // The model called it a task; the rule overrules it, because by the time a
  // card exists that meeting is long over.
  assert.ok(
    !pending().some((i) => i.source_text.includes('join the meeting')),
    'the 2-minute meeting is not on the board'
  );
  const outcome = db
    .prepare("SELECT outcome FROM seen_messages WHERE channel_id='C1' AND message_ts=?")
    .get(ASK_EPHEMERAL);
  assert.equal(outcome.outcome, 'not_task', 'and it is remembered, so it never comes back');
});
