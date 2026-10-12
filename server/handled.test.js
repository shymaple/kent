/**
 * "Already handled in Slack" — the rule that keeps a wake-up backlog readable.
 *
 * Unit tests for the two signals, then a full sync proving the three places they
 * have to hold: a new message is never queued, a triage item queued earlier
 * retires itself, and a reply written in Slack lands on the card it belongs to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_HANDLED_REACTIONS,
  handledInSlack,
  myHandledReaction,
  myReplyAfter,
  parseHandledReactions,
} from './handled.js';

const ME = 'U0ME';

// ------------------------------------------------------------------ units

test('a tick I left counts, one someone else left does not', () => {
  const mine = { ts: '1.0', reactions: [{ name: 'white_check_mark', users: [ME], count: 1 }] };
  const theirs = { ts: '1.0', reactions: [{ name: 'white_check_mark', users: ['U9'], count: 1 }] };

  assert.equal(myHandledReaction(mine, ME), 'white_check_mark');
  // Someone else ticking it says nothing about whether *I* still owe the work.
  assert.equal(myHandledReaction(theirs, ME), null);
});

test('a reaction that only means "seen" is not "handled"', () => {
  const seen = { ts: '1.0', reactions: [{ name: 'eyes', users: [ME], count: 1 }] };
  assert.equal(myHandledReaction(seen, ME), null);
});

test('skin-tone variants still match', () => {
  const m = { ts: '1.0', reactions: [{ name: 'heavy_check_mark::skin-tone-3', users: [ME], count: 1 }] };
  assert.equal(myHandledReaction(m, ME), 'heavy_check_mark');
});

test('reply_users on the parent is enough - no extra API call needed', () => {
  const parent = { ts: '100.0', user: 'U1', reply_users: [ME], latest_reply: '140.0' };
  assert.equal(myReplyAfter(parent, ME, []), '140.0');
});

test('a reply of mine in the thread counts, an earlier one does not', () => {
  const message = { ts: '100.0', user: 'U1' };
  const after = [{ ts: '120.0', user: ME, thread_ts: '100.0' }];
  const before = [{ ts: '90.0', user: ME, thread_ts: '100.0' }];

  assert.equal(myReplyAfter(message, ME, after), '120.0');
  assert.equal(myReplyAfter(message, ME, before), null, 'answering before the ask is not answering it');
});

test('a reply in a different thread is not a reply to this one', () => {
  const message = { ts: '100.0', user: 'U1' };
  const elsewhere = [{ ts: '120.0', user: ME, thread_ts: '55.0' }];
  assert.equal(myReplyAfter(message, ME, elsewhere), null);
});

test('an untouched message is not handled', () => {
  assert.equal(handledInSlack({ ts: '100.0', user: 'U1' }, { myUserId: ME }), null);
});

test('bad reaction config falls back to the defaults rather than matching nothing', () => {
  assert.deepEqual(parseHandledReactions('not json'), DEFAULT_HANDLED_REACTIONS);
  assert.deepEqual(parseHandledReactions('[]'), DEFAULT_HANDLED_REACTIONS);
  assert.deepEqual(parseHandledReactions('[":+1:"]'), ['+1'], 'colons are stripped');
});

// ------------------------------------------------------------ integration

const dir = mkdtempSync(join(tmpdir(), 'kent-handled-'));
process.env.MYBOT_DB = join(dir, 'test.db');
process.env.SLACK_USER_TOKEN = 'xoxp-test';
process.env.MYBOT_NO_KEYCHAIN = '1';

const { db, setSetting } = await import('./db.js');
const { runSync } = await import('./sync.js');

const NOW = Math.floor(Date.now() / 1000);
const ts = (offset) => (NOW + offset).toFixed(6);

const ASK_TICKED = ts(-500);
const ASK_ANSWERED = ts(-400);
const ASK_OPEN = ts(-300);
const ASK_LATER_TICKED = ts(-200);

let history = [
  // Read on my phone and ticked off: settled, and must never ask again.
  {
    user: 'U1',
    text: `<@${ME}> can you approve the invoice`,
    ts: ASK_TICKED,
    reactions: [{ name: 'white_check_mark', users: [ME], count: 1 }],
  },
  // Answered in the thread from my phone; Slack reports me in reply_users.
  {
    user: 'U1',
    text: `<@${ME}> can you send the deck`,
    ts: ASK_ANSWERED,
    reply_users: [ME],
    latest_reply: ts(-390),
    reply_count: 1,
  },
  // Untouched: this is the one that deserves my attention.
  { user: 'U1', text: `<@${ME}> please review the pricing page`, ts: ASK_OPEN },
  // Untouched at first; ticked in Slack between the two syncs below.
  { user: 'U1', text: `<@${ME}> update the runbook`, ts: ASK_LATER_TICKED },
];

/** Threads, keyed by parent ts, as conversations.replies would return them. */
let threads = {};

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
    case 'conversations.replies': {
      const parent = params.get('ts');
      const thread = threads[parent] ?? history.filter((m) => m.ts === parent);
      const oldest = Number(params.get('oldest') || 0);
      return reply({ messages: thread.filter((m) => Number(m.ts) >= oldest) });
    }
    case 'chat.getPermalink':
      return reply({ permalink: `https://test.slack.com/archives/C1/p${params.get('message_ts').replace('.', '')}` });
    default:
      return reply({});
  }
};

const classifier = async (candidates) => ({
  calls: 1,
  raw: '[]',
  verdicts: new Map(
    candidates.map((c) => [
      c.id,
      { id: c.id, isTask: true, title: `Task: ${c.text.slice(0, 20)}`, priority: 'medium', confidence: 0.9 },
    ])
  ),
});

const sync = () => runSync({ classifier });
const pending = () => db.prepare("SELECT * FROM inbox_items WHERE state='pending'").all();

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('work I already dealt with in Slack never reaches triage', async () => {
  setSetting('timezone', 'UTC');
  setSetting('backfill_days', '7');

  const stats = await sync();
  assert.equal(stats.errors.length, 0, stats.errors.join('; '));

  // Four messages all addressed to me; two were settled in Slack already.
  assert.equal(stats.candidates, 2, 'the ticked and the answered ask never became candidates');
  assert.equal(stats.handled, 2);
  assert.equal(stats.inboxed, 2);

  const titles = pending().map((i) => i.source_text);
  assert.ok(titles.some((t) => t.includes('pricing page')));
  assert.ok(titles.some((t) => t.includes('runbook')));
  assert.ok(!titles.some((t) => t.includes('invoice')), 'the ticked one is gone for good');
});

test('a ticked message stays gone on the next sync', async () => {
  // Cursors have moved past it, but the seen record is what really guarantees
  // this - a re-synced channel must not resurrect settled work.
  const seen = db
    .prepare("SELECT outcome FROM seen_messages WHERE channel_id='C1' AND message_ts=?")
    .get(ASK_TICKED);
  assert.equal(seen.outcome, 'handled');
});

test('a triage item I handle in Slack afterwards retires itself', async () => {
  const before = pending().find((i) => i.message_ts === ASK_LATER_TICKED);
  assert.ok(before, 'it was queued by the first sync');

  // I tick it in Slack while the laptop is asleep.
  history = history.map((m) =>
    m.ts === ASK_LATER_TICKED
      ? { ...m, reactions: [{ name: 'white_check_mark', users: [ME], count: 1 }] }
      : m
  );

  const stats = await sync();
  assert.equal(stats.handled, 1, 'the re-check caught it without me triaging it');

  const after = db.prepare('SELECT state FROM inbox_items WHERE id = ?').get(before.id);
  assert.equal(after.state, 'dismissed');
  assert.ok(!pending().some((i) => i.message_ts === ASK_LATER_TICKED));
});

test('a reply I wrote in Slack shows up on the card as a reply', async () => {
  // Approve the open ask, so there is a card whose thread I can answer.
  const item = pending().find((i) => i.message_ts === ASK_OPEN);
  const listId = db.prepare("SELECT id FROM lists WHERE semantic='backlog'").get().id;
  const taskId = db.prepare(
    `INSERT INTO tasks (title, status, list_id, priority, links, channel_id, channel_name,
                        message_ts, thread_ts, position)
     VALUES (?, 'open', ?, 'medium', '[]', 'C1', 'eng', ?, ?, 1)`
  ).run(item.title, listId, item.message_ts, ASK_OPEN).lastInsertRowid;

  // Answering from my phone: a thread reply Kent never sent.
  const replyTs = ts(-100);
  const myReply = { user: ME, text: 'done, pushed the fix', ts: replyTs, thread_ts: ASK_OPEN };
  history = [...history, { ...history.find((m) => m.ts === ASK_OPEN), reply_users: [ME], latest_reply: replyTs }];
  threads[ASK_OPEN] = [history.find((m) => m.ts === ASK_OPEN), myReply];
  history.push(myReply);

  const stats = await sync();
  assert.equal(stats.errors.length, 0, stats.errors.join('; '));

  const comment = db.prepare('SELECT * FROM comments WHERE task_id = ?').get(taskId);
  assert.ok(comment, 'the card knows I answered');
  assert.equal(comment.body, 'done, pushed the fix');
  assert.equal(comment.kind, 'slack');
  assert.equal(comment.slack_ts, replyTs, 'stamped as replied, so the board stops nagging');

  // Running again must not log the same reply twice.
  await sync();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM comments WHERE task_id = ?').get(taskId).n, 1);
});
