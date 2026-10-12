/**
 * End-to-end email sync. Gmail is stubbed at the HTTP layer (so gmail.js runs
 * for real) and the classifier is injected (so no CLI is spawned).
 *
 * Proves email obeys the same cost shape as Slack - nothing the prefilter can
 * reject reaches the model - and the two behaviours that are email's own: a
 * later message in a tracked thread is proposed as a subtask of its card, and a
 * thread you already replied to never reaches triage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kent-mail-'));
process.env.MYBOT_DB = join(dir, 'test.db');
process.env.MYBOT_NO_KEYCHAIN = '1';
process.env.SLACK_USER_TOKEN = '';
process.env.MYBOT_GMAIL_OAUTH = JSON.stringify({ clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' });

const { db, getSetting, setSetting } = await import('./db.js');
const { runSync } = await import('./sync.js');
const gmail = await import('./gmail.js');

const ME = 'me@example.com';
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');

/** The mailbox Gmail will serve. Each test adds to it. */
const MAILBOX = [];
let tokenFails = false;
const requests = [];

let clock = Date.now();
function deliver({ id, threadId = `t-${id}`, from, to = ME, cc, subject, body, labels = ['INBOX'], headers = [] }) {
  clock += 2000;
  MAILBOX.push({
    id,
    threadId,
    labelIds: labels,
    internalDate: String(clock),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        ...(cc ? [{ name: 'Cc', value: cc }] : []),
        { name: 'Subject', value: subject },
        ...headers,
      ],
      body: { data: b64(body) },
    },
  });
}

/** Stand in for Google so gmail.js itself is under test. */
globalThis.fetch = async (url) => {
  const u = new URL(url);
  requests.push(u.pathname);
  const reply = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });

  if (u.hostname === 'oauth2.googleapis.com') {
    return tokenFails
      ? reply({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)
      : reply({ access_token: 'access', expires_in: 3600 });
  }

  const path = u.pathname.replace('/gmail/v1/users/me', '');
  if (path === '/profile') return reply({ emailAddress: ME });
  if (path === '/messages') {
    const after = Number(/after:(\d+)/.exec(u.searchParams.get('q'))[1]);
    const messages = MAILBOX.filter((m) => Number(m.internalDate) / 1000 >= after)
      .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
      .map((m) => ({ id: m.id, threadId: m.threadId }));
    return reply({ messages });
  }
  if (path.startsWith('/messages/')) {
    return reply(MAILBOX.find((m) => m.id === path.split('/')[2]));
  }
  if (path.startsWith('/threads/')) {
    const threadId = path.split('/')[2];
    return reply({ messages: MAILBOX.filter((m) => m.threadId === threadId) });
  }
  throw new Error(`unexpected request to ${url}`);
};

let llmInvocations = 0;
let lastBatch = null;
const fakeClassifier = async (candidates) => {
  llmInvocations++;
  lastBatch = candidates;
  return {
    verdicts: new Map(
      candidates.map((c) => [
        c.id,
        { id: c.id, isTask: true, title: 'Send the revised quote', description: null, priority: 'medium', dueDate: null, category: 'other', confidence: 0.9 },
      ])
    ),
    calls: 1,
    raw: '[]',
  };
};
const sync = () => runSync({ classifier: fakeClassifier });

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('connecting Gmail starts from now and reads none of the existing inbox', async () => {
  deliver({ id: 'old1', from: 'Priya <priya@client.com>', subject: 'Old ask', body: 'Please send the old thing.' });
  clock = Date.now() - 60_000;      // everything so far predates the connection
  MAILBOX[0].internalDate = String(clock);

  const stats = await sync();

  assert.equal(stats.skipped, undefined, 'Gmail alone is enough to run a sync');
  assert.equal(stats.candidates, 0);
  assert.equal(llmInvocations, 0);
  assert.equal(getSetting('gmail_address'), ME);
  assert.ok(Number(getSetting('gmail_cursor')) > 0, 'the cursor is set to now');
  assert.ok(!requests.some((p) => p.includes('/messages')), 'the old inbox is not even listed');
  clock = Date.now();
});

test('only mail a person addressed to me reaches the model', async () => {
  deliver({ id: 'ask', threadId: 't-ask', from: 'Priya Shah <priya@client.com>', subject: 'Renewal quote', body: 'Could you send the revised quote by Wednesday?' });
  deliver({ id: 'news', from: 'Weekly <newsletter@vendor.io>', subject: 'This week', body: 'Top stories', headers: [{ name: 'List-Unsubscribe', value: '<mailto:u@v>' }] });
  deliver({ id: 'cc', from: 'Alex <alex@example.com>', to: 'boss@example.com', cc: ME, subject: 'FYI', body: 'Keeping you in the loop.' });
  deliver({ id: 'promo', from: 'Shop <deals@shop.com>', subject: 'Sale', body: '50% off', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] });

  const stats = await sync();

  assert.equal(stats.mail, 4, 'all four were read');
  assert.equal(stats.candidates, 1, 'one survived the free filter');
  assert.equal(llmInvocations, 1);
  assert.equal(lastBatch.length, 1);
  assert.equal(lastBatch[0].channel, 'email');
  assert.match(lastBatch[0].text, /^Subject: Renewal quote\n\nCould you send/);

  const item = db.prepare('SELECT * FROM inbox_items').get();
  assert.equal(item.source, 'email');
  assert.equal(item.reason, 'email_to');
  assert.equal(item.assigner_name, 'Priya Shah');
  assert.equal(item.thread_ts, 't-ask');
  assert.match(item.permalink, /^https:\/\/mail\.google\.com\/.*t-ask$/);
  assert.equal(item.sent_at, new Date(Number(MAILBOX.find((m) => m.id === 'ask').internalDate)).toISOString());
  assert.equal(item.parent_task_id, null);
});

test('a second sync with no new mail makes zero model calls and no duplicates', async () => {
  const before = llmInvocations;
  const stats = await sync();
  assert.equal(stats.candidates, 0);
  assert.equal(llmInvocations, before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inbox_items').get().n, 1);
});

test('a thread I already replied to never reaches triage', async () => {
  deliver({ id: 'q1', threadId: 't-replied', from: 'Dana <dana@client.com>', subject: 'Invoice', body: 'Can you resend the invoice?' });
  deliver({ id: 'q1-reply', threadId: 't-replied', from: `Me <${ME}>`, to: 'dana@client.com', subject: 'Re: Invoice', body: 'Sent, see attached.', labels: ['SENT'] });

  const before = llmInvocations;
  const stats = await sync();

  assert.equal(stats.handled, 1);
  assert.equal(llmInvocations, before, 'handled mail costs no model call');
  assert.equal(db.prepare("SELECT outcome FROM seen_messages WHERE message_ts = 'q1'").get().outcome, 'handled');
});

test('a later ask in a thread that has a card is proposed as a subtask of it', async () => {
  // The first email was approved onto the board.
  const listId = db.prepare("SELECT id FROM lists WHERE semantic = 'backlog'").get().id;
  const taskId = db.prepare(
    `INSERT INTO tasks (title, status, list_id, priority, links, channel_id, channel_name, message_ts, thread_ts, source)
     VALUES ('Send the revised quote', 'open', ?, 'medium', '[]', 'gmail', 'Email', 'ask', 't-ask', 'email')`
  ).run(listId).lastInsertRowid;

  deliver({
    id: 'ask-2',
    threadId: 't-ask',
    from: 'Priya Shah <priya@client.com>',
    subject: 'Re: Renewal quote',
    body: 'Thanks! Can you also attach the updated DPA?\n\nOn Fri, 7 Aug 2026, Me wrote:\n> quote attached',
  });

  await sync();

  assert.match(lastBatch[0].threadContext, /already tracked as the task "Send the revised quote"/);
  assert.ok(!lastBatch[0].text.includes('quote attached'), 'the quoted history is not shown to the model');

  const item = db.prepare("SELECT * FROM inbox_items WHERE message_ts = 'ask-2'").get();
  assert.equal(item.parent_task_id, taskId);
  assert.equal(item.state, 'pending', 'it waits for approval; nothing is added to the card on its own');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM subtasks').get().n, 0);
});

test('a lapsed Google grant is reported, and does not stop the queue being judged', async () => {
  // A message is already captured and waiting on the model...
  deliver({ id: 'late', from: 'Sam <sam@client.com>', subject: 'Contract', body: 'Please countersign the contract.' });
  await runSync({ classifier: async () => { throw new Error('claude CLI failed'); } });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pending_candidates').get().n, 1);

  // ...then Google stops honouring the refresh token.
  tokenFails = true;
  gmail.resetAccess();
  deliver({ id: 'unread', from: 'Sam <sam@client.com>', subject: 'Another', body: 'Please review the appendix.' });

  const stats = await sync();

  assert.ok(stats.errors.some((e) => /Reconnect Gmail/.test(e)), 'the user is told what to do');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM inbox_items WHERE message_ts = 'late'").get().n, 1,
    'what was already captured is still judged');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pending_candidates').get().n, 0);

  // And the mail it could not read is not skipped: the cursor did not move past it.
  tokenFails = false;
  gmail.resetAccess();
  await sync();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM inbox_items WHERE message_ts = 'unread'").get().n, 1);
});

test('a backfill setting is honoured on first connect', async () => {
  db.prepare("DELETE FROM seen_messages").run();
  db.prepare('DELETE FROM inbox_items').run();
  setSetting('gmail_cursor', '');
  setSetting('backfill_days', '1');

  const stats = await sync();
  assert.ok(stats.candidates >= 1, 'recent mail from before the connection is picked up');
  setSetting('backfill_days', '0');
});
