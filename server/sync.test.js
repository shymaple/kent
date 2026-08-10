/**
 * End-to-end sync test. Slack is stubbed at the HTTP layer (so slack.js runs for
 * real) and the classifier is injected (so no CLI is spawned).
 *
 * Proves the loop: fetch -> prefilter -> classify -> inbox, and that the model
 * is called once per sync with only candidates - never when nothing is new.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mybot-test-'));
process.env.MYBOT_DB = join(dir, 'test.db');
process.env.SLACK_USER_TOKEN = 'xoxp-test';
process.env.MYBOT_NO_KEYCHAIN = '1';

const { db, setSetting } = await import('./db.js');
const { runSync } = await import('./sync.js');

const ME = 'U0ME';
const NOW = Math.floor(Date.now() / 1000);
const ts = (offset) => (NOW + offset).toFixed(6);

const HISTORY = {
  C1: [
    {
      user: 'U1',
      text: `<@${ME}> please review the pricing deck by tomorrow <https://docs.google.com/document/d/x|Deck>`,
      ts: ts(-300),
    },
    { user: 'U2', text: 'anyone up for coffee', ts: ts(-280) },
    { user: 'U2', text: '<!channel> fill the snack form', ts: ts(-260) },
    { user: ME, text: 'on it', ts: ts(-240) },
  ],
  D1: [
    // Plain DM chatter: must NOT become a candidate.
    { user: 'U3', text: 'morning! how was the weekend?', ts: ts(-220) },
    // Same DM, but addressed to me: this one counts.
    { user: 'U3', text: `<@${ME}> can you send the invoice today?`, ts: ts(-200) },
  ],
};

const USERS = [
  { id: 'U1', profile: { display_name: 'Alex', real_name: 'Alex N' }, name: 'priya' },
  { id: 'U2', profile: { display_name: 'Jordan', real_name: 'Jordan K' }, name: 'ravi' },
  { id: 'U3', profile: { display_name: 'Boss', real_name: 'The Boss' }, name: 'boss' },
];

/** Stand in for the Slack HTTP API so slack.js itself is under test. */
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/api/')[1];
  const params = new URLSearchParams(init.body);
  const reply = (obj) => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ ok: true, ...obj }) });

  switch (method) {
    case 'auth.test':
      return reply({ user_id: ME, user: 'me', team_id: 'T1', team: 'Test', url: 'https://test.slack.com/' });
    case 'users.conversations':
      return reply({
        channels: [
          { id: 'C1', name: 'eng' },
          { id: 'D1', is_im: true, user: 'U3' },
        ],
      });
    case 'users.list':
      return reply({ members: USERS });
    case 'conversations.history': {
      const channel = params.get('channel');
      const oldest = Number(params.get('oldest') || 0);
      const messages = (HISTORY[channel] ?? []).filter((m) => Number(m.ts) > oldest);
      return reply({ messages, has_more: false });
    }
    case 'conversations.replies':
      return reply({ messages: [] });
    case 'chat.getPermalink':
      return reply({
        permalink: `https://test.slack.com/archives/${params.get('channel')}/p${params.get('message_ts').replace('.', '')}`,
      });
    default:
      return reply({});
  }
};

let llmInvocations = 0;
let lastBatch = null;

/** Injected classifier: records what it was asked to look at. */
const fakeClassifier = async (candidates) => {
  llmInvocations++;
  lastBatch = candidates;
  const verdicts = new Map(
    candidates.map((c) => [
      c.id,
      {
        id: c.id,
        isTask: true,
        title: `Task: ${c.text.slice(0, 24)}`,
        description: null,
        priority: 'medium',
        dueDate: null,
        category: 'other',
        confidence: 0.8,
      },
    ])
  );
  return { verdicts, calls: 1, raw: '[]' };
};

const sync = () => runSync({ classifier: fakeClassifier });

test('sync inboxes only real candidates and calls the model once', async () => {
  setSetting('timezone', 'UTC');
  setSetting('backfill_days', '7');   // fixtures sit minutes in the past
  const stats = await sync();

  assert.equal(stats.errors.length, 0, stats.errors.join('; '));
  // mention + broadcast + the DM that addresses me = 3. Coffee chatter, my own
  // message and the "how was the weekend" DM are all dropped for free.
  assert.equal(stats.messages, 6);
  assert.equal(stats.candidates, 3);
  assert.equal(stats.inboxed, 3);
  assert.equal(stats.llmCalls, 1);
  assert.equal(llmInvocations, 1, 'exactly one batched model call');
  assert.equal(lastBatch.length, 3, 'only candidates reach the model');

  const items = db.prepare("SELECT * FROM inbox_items WHERE state='pending'").all();
  assert.equal(items.length, 3);

  const broadcast = items.find((i) => i.is_broadcast === 1);
  assert.ok(broadcast, 'broadcast captured');
  assert.equal(broadcast.priority, 'low', 'broadcasts are demoted to low');
  assert.equal(broadcast.category, 'broadcast');

  const mention = items.find((i) => i.reason === 'mention');
  assert.match(mention.permalink, /archives\/C1/);
  assert.equal(JSON.parse(mention.links)[0].label, 'Deck', 'doc link extracted deterministically');
  assert.equal(mention.assigner_name, 'Alex');

  const dm = items.find((i) => i.reason === 'dm');
  assert.equal(dm.assigner_name, 'Boss');
  assert.equal(dm.channel_name, '@Boss', 'DMs are labelled with the other person');
});

test('a second sync with nothing new makes zero model calls', async () => {
  const before = llmInvocations;
  const stats = await sync();
  assert.equal(stats.candidates, 0);
  assert.equal(stats.llmCalls, 0);
  assert.equal(llmInvocations, before, 'no LLM call when nothing is new');
});

test('priority people force High regardless of the model verdict', async () => {
  db.prepare('DELETE FROM seen_messages').run();
  db.prepare('DELETE FROM inbox_items').run();
  db.prepare('UPDATE channels SET last_synced_ts = NULL').run();
  db.prepare('UPDATE people SET is_priority = 0').run();
  db.prepare("UPDATE people SET is_priority = 1 WHERE slack_user_id = 'U3'").run();

  await sync();
  const dm = db.prepare("SELECT * FROM inbox_items WHERE reason = 'dm'").get();
  assert.equal(dm.priority, 'high');
  db.prepare('UPDATE people SET is_priority = 0').run();
});

test('a priority person is read even when they never mention me', async () => {
  db.prepare('DELETE FROM seen_messages').run();
  db.prepare('DELETE FROM inbox_items').run();
  db.prepare('UPDATE channels SET last_synced_ts = NULL').run();
  db.prepare('UPDATE people SET is_priority = 0').run();

  // U2 posts the coffee chatter and the broadcast in #eng, and mentions nobody.
  db.prepare("UPDATE people SET is_priority = 1 WHERE slack_user_id = 'U2'").run();

  const stats = await sync();
  const chatter = db
    .prepare("SELECT * FROM inbox_items WHERE reason = 'priority_person'")
    .all();
  assert.ok(chatter.length >= 1, 'their un-mentioned message now reaches the model');
  assert.ok(stats.candidates > 3, 'more candidates than the mention-only baseline');

  db.prepare("UPDATE people SET is_priority = 0 WHERE slack_user_id = 'U2'").run();
});

test('turning off priority watching restores the mention-only bar', async () => {
  db.prepare('DELETE FROM seen_messages').run();
  db.prepare('DELETE FROM inbox_items').run();
  db.prepare('UPDATE channels SET last_synced_ts = NULL').run();
  db.prepare('UPDATE people SET is_priority = 0').run();
  db.prepare("UPDATE people SET is_priority = 1 WHERE slack_user_id = 'U2'").run();
  setSetting('watch_priority_people', 'false');

  const stats = await sync();
  assert.equal(stats.candidates, 3, 'back to mention + broadcast + addressed DM');
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM inbox_items WHERE reason = 'priority_person'").get().n,
    0
  );

  setSetting('watch_priority_people', 'true');
  db.prepare("UPDATE people SET is_priority = 0 WHERE slack_user_id = 'U2'").run();
});

test('a message the model rejects is recorded, not inboxed', async () => {
  db.prepare('DELETE FROM seen_messages').run();
  db.prepare('DELETE FROM inbox_items').run();
  db.prepare('UPDATE channels SET last_synced_ts = NULL').run();
  db.prepare('UPDATE people SET is_priority = 0').run();

  await runSync({
    classifier: async (candidates) => ({
      verdicts: new Map(
        candidates.map((c) => [c.id, { id: c.id, isTask: false, title: '', priority: 'medium', confidence: 0.9 }])
      ),
      calls: 1,
      raw: '[]',
    }),
  });

  assert.equal(db.prepare('SELECT COUNT(*) n FROM inbox_items').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM seen_messages WHERE outcome='not_task'").get().n, 3);
});

test('a classifier failure holds messages back instead of inboxing raw text', async () => {
  db.prepare('DELETE FROM seen_messages').run();
  db.prepare('DELETE FROM inbox_items').run();
  db.prepare('UPDATE channels SET last_synced_ts = NULL').run();
  db.prepare('UPDATE people SET is_priority = 0').run();

  const stats = await runSync({
    classifier: async () => {
      throw new Error('claude CLI failed: timed out after 120s');
    },
  });

  assert.equal(stats.inboxed, 0, 'unclassified messages must not reach the board');
  assert.equal(stats.retrying, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inbox_items').get().n, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM seen_messages').get().n,
    0,
    'nothing is marked seen, so the next sync retries it'
  );
  assert.equal(
    db.prepare("SELECT last_synced_ts FROM channels WHERE id = 'C1'").get().last_synced_ts,
    null,
    'the channel cursor is held back'
  );
});

test('the retried messages are picked up on the next healthy sync', async () => {
  const stats = await sync();
  assert.equal(stats.candidates, 3, 'the held-back messages come round again');
  assert.equal(stats.inboxed, 3);
  assert.equal(stats.retrying, 0);
});

test('dismissed messages never come back', async () => {
  const item = db.prepare('SELECT * FROM inbox_items LIMIT 1').get();
  db.prepare("UPDATE inbox_items SET state='dismissed' WHERE id = ?").run(item.id);
  db.prepare(
    `INSERT INTO seen_messages (channel_id, message_ts, outcome) VALUES (?, ?, 'dismissed')
     ON CONFLICT(channel_id, message_ts) DO UPDATE SET outcome='dismissed'`
  ).run(item.channel_id, item.message_ts);

  db.prepare('UPDATE channels SET last_synced_ts = NULL').run();
  const before = db.prepare('SELECT COUNT(*) n FROM inbox_items').get().n;
  await sync();
  const after = db.prepare('SELECT COUNT(*) n FROM inbox_items').get().n;
  assert.equal(after, before, 'a dismissed message is not re-inboxed');
});

test('a zero backfill ignores everything sent before setup', async () => {
  db.prepare('DELETE FROM seen_messages').run();
  db.prepare('DELETE FROM inbox_items').run();
  db.prepare('UPDATE channels SET last_synced_ts = NULL, is_excluded = 0').run();
  setSetting('backfill_days', '0');

  const stats = await sync();
  assert.equal(stats.candidates, 0, 'existing history must not be dragged in on first run');
  assert.equal(stats.llmCalls, 0);

  setSetting('backfill_days', '7');   // restore for any later test
});

test('excluded channels are skipped entirely', async () => {
  db.prepare('DELETE FROM seen_messages').run();
  db.prepare('DELETE FROM inbox_items').run();
  db.prepare('UPDATE channels SET last_synced_ts = NULL').run();
  db.prepare('UPDATE people SET is_priority = 0').run();
  db.prepare("UPDATE channels SET is_excluded = 1 WHERE id = 'C1'").run();

  const stats = await sync();
  assert.equal(stats.candidates, 1, 'only the DM survives when #eng is excluded');
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
