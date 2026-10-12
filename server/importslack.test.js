/**
 * Making a task from a pasted Slack link.
 *
 * Slack is stubbed at the HTTP layer and the model is injected, so this proves
 * the whole path a paste takes: nothing but a real message link reaches Slack,
 * the card comes out with its sender, channel, thread and attachments filled
 * in, and a model that can't be reached still leaves the user with a card.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kent-import-'));
process.env.MYBOT_DB = join(dir, 'test.db');
process.env.MYBOT_NO_KEYCHAIN = '1';
process.env.SLACK_USER_TOKEN = 'xoxp-test';

const { db, setSetting } = await import('./db.js');
const { importSlackMessage } = await import('./importslack.js');

setSetting('slack_team_domain', 'https://acme.slack.com/');
db.prepare("INSERT INTO channels (id, name, kind) VALUES ('C0123ABCD', 'eng', 'channel')").run();
db.prepare("INSERT INTO people (slack_user_id, display_name) VALUES ('U0DANA001', 'Dana'), ('U0ME00001', 'Me')").run();

const TOP = {
  user: 'U0DANA001',
  ts: '1720000000.000200',
  text: '<@U0ME00001> can you send the Q3 forecast to finance by Friday? <https://docs.google.com/spreadsheets/d/x|Forecast>',
  files: [{ permalink: 'https://acme.slack.com/files/U0DANA001/F1/template.xlsx', name: 'template.xlsx', filetype: 'xlsx' }],
};
const REPLY = { user: 'U0DANA001', ts: '1720000000.000300', thread_ts: '1720000000.000200', text: 'also please cc legal on it' };

const calls = [];
let slackError = null;

globalThis.fetch = async (url, init) => {
  const method = String(url).split('/api/')[1];
  const params = new URLSearchParams(init.body);
  calls.push(method);
  const reply = (obj) => ({ ok: true, status: 200, headers: new Map(), json: async () => obj });

  if (slackError) return reply({ ok: false, error: slackError });
  switch (method) {
    case 'conversations.history':
      return reply({ ok: true, messages: params.get('latest') === TOP.ts ? [TOP] : [] });
    case 'conversations.replies':
      return reply({ ok: true, messages: [TOP, REPLY].filter((m) => m.ts === params.get('latest')) });
    case 'chat.getPermalink':
      return reply({ ok: true, permalink: `https://acme.slack.com/archives/${params.get('channel')}/p${params.get('message_ts').replace('.', '')}` });
    default:
      return reply({ ok: true });
  }
};

let seenByModel = null;
const model = async (candidates) => {
  seenByModel = candidates;
  return {
    verdicts: new Map(candidates.map((c) => [c.id, {
      id: c.id, isTask: true, title: 'Send Q3 forecast to finance', description: 'Dana needs it by Friday.',
      priority: 'high', dueDate: null, category: 'doc', confidence: 0.9,
    }])),
    calls: 1,
    raw: '[]',
  };
};

const TOP_URL = 'https://acme.slack.com/archives/C0123ABCD/p1720000000000200';

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('anything that is not a Slack message link is refused without touching the network', async () => {
  for (const url of ['https://docs.google.com/document/d/abc', 'https://acme.slack.com/archives/C0123ABCD', 'hello', 'https://other.slack.com/archives/C0123ABCD/p1720000000000200']) {
    await assert.rejects(importSlackMessage(url, { classifier: model }), (err) => err.status === 400 && err.userMessage.length > 20);
  }
  assert.equal(calls.length, 0, 'Slack was never asked');
  assert.equal(seenByModel, null, 'and neither was the model');
});

test('a message link becomes a card with everything filled in', async () => {
  const { task, phrasedByModel } = await importSlackMessage(TOP_URL, { classifier: model });

  assert.equal(phrasedByModel, true);
  assert.equal(task.title, 'Send Q3 forecast to finance');
  assert.equal(task.description, 'Dana needs it by Friday.');
  assert.equal(task.priority, 'high');
  assert.equal(task.assigner_name, 'Dana');
  assert.equal(task.channel_name, 'eng');
  assert.equal(task.channel_id, 'C0123ABCD');
  assert.equal(task.message_ts, TOP.ts);
  assert.equal(task.permalink, TOP_URL);
  assert.equal(task.source_text, TOP.text, 'the original is kept exactly as Slack sent it');
  assert.ok(task.due_date, 'the "by Friday" in the message became a due date');

  const links = JSON.parse(task.links);
  assert.ok(links.some((l) => l.url.includes('docs.google.com') && !l.kind), 'the written link is a link');
  assert.ok(links.some((l) => l.kind === 'file' && l.label.includes('template.xlsx')), 'the upload is an attachment');

  assert.match(seenByModel[0].text, /@Me can you send/, 'the model reads names, not member ids');
  assert.equal(seenByModel.length, 1, 'one message, one call');
});

test('it lands on the board directly and a later sync will not offer it again', () => {
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inbox_items').get().n, 0);
  assert.equal(
    db.prepare("SELECT outcome FROM seen_messages WHERE channel_id = 'C0123ABCD' AND message_ts = ?").get(TOP.ts).outcome,
    'inboxed'
  );
});

test('pasting the same message twice points at the card that already exists', async () => {
  const first = db.prepare('SELECT id FROM tasks WHERE message_ts = ?').get(TOP.ts).id;
  await assert.rejects(importSlackMessage(TOP_URL, { classifier: model }), (err) =>
    err.status === 409 && err.code === 'exists' && err.taskId === first);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 1);
});

test('a link to a reply imports that reply and keeps its thread', async () => {
  const { task } = await importSlackMessage(
    `https://acme.slack.com/archives/C0123ABCD/p1720000000000300?thread_ts=${TOP.ts}&cid=C0123ABCD`,
    { classifier: async () => ({ verdicts: new Map(), calls: 1, raw: '[]' }) }
  );
  assert.equal(task.message_ts, REPLY.ts);
  assert.equal(task.thread_ts, TOP.ts, 'so a reply from the card goes into the right thread');
  assert.equal(task.title, 'also please cc legal on it', 'no verdict from the model: the message titles itself');
});

test('a model that cannot be reached still leaves a usable card', async () => {
  db.prepare('DELETE FROM tasks').run();
  const { task, phrasedByModel } = await importSlackMessage(TOP_URL, {
    classifier: async () => { throw new Error('claude CLI failed: not logged in'); },
  });
  assert.equal(phrasedByModel, false);
  assert.match(task.title, /can you send the Q3 forecast/);
  assert.ok(!task.title.includes('<@'), 'raw Slack markup never reaches a title');
  assert.equal(task.assigner_name, 'Dana');
  assert.ok(task.due_date, 'the rule-based deadline parser still found Friday');
});

test('a conversation Kent cannot see is explained in plain words', async () => {
  db.prepare('DELETE FROM tasks').run();
  slackError = 'channel_not_found';
  await assert.rejects(importSlackMessage(TOP_URL, { classifier: model }), (err) =>
    err.status === 502 && /member/.test(err.userMessage) && !/channel_not_found/.test(err.userMessage));
  slackError = null;
});

test('a deleted message is reported, not turned into an empty card', async () => {
  await assert.rejects(
    importSlackMessage('https://acme.slack.com/archives/C0123ABCD/p1720000000999999', { classifier: model }),
    (err) => err.status === 404
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 0);
});
