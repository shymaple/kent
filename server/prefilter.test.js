import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAliasMatcher, classifyCandidate, extractLinks, plainText } from './prefilter.js';
import { enrich, daysUntil, localDateString } from './enrich.js';
import { parseJsonArray, validateVerdict, chunk } from './classify.js';

const ME = 'U0ME';
const ctx = (over = {}) => ({
  myUserId: ME,
  channelKind: 'channel',
  aliasMatcher: buildAliasMatcher(['Alex', 'al']),
  myThreadTs: new Set(['1700000000.000100']),
  ...over,
});

test('detects a direct @mention', () => {
  const r = classifyCandidate({ user: 'U0BOSS', text: `<@${ME}> can you ship this?`, ts: '1.0' }, ctx());
  assert.deepEqual(r, { reason: 'mention', isBroadcast: false });
});

test('ordinary DM chatter is NOT a candidate', () => {
  // A DM has to earn a card the same way a channel message does.
  assert.equal(classifyCandidate({ user: 'U0X', text: 'ping me later', ts: '1.0' }, ctx({ channelKind: 'im' })), null);
  assert.equal(classifyCandidate({ user: 'U0X', text: 'sounds good', ts: '1.0' }, ctx({ channelKind: 'mpim' })), null);
});

test('a DM that mentions me is a candidate, labelled as a DM', () => {
  const dm = classifyCandidate({ user: 'U0X', text: `<@${ME}> send the invoice`, ts: '1.0' }, ctx({ channelKind: 'im' }));
  assert.deepEqual(dm, { reason: 'dm', isBroadcast: false });

  const mpim = classifyCandidate({ user: 'U0X', text: `<@${ME}> sort this out`, ts: '1.0' }, ctx({ channelKind: 'mpim' }));
  assert.deepEqual(mpim, { reason: 'group_dm', isBroadcast: false });
});

test('a DM using my name without an @mention is still caught', () => {
  const r = classifyCandidate({ user: 'U0X', text: 'Alex can you send the invoice', ts: '1.0' }, ctx({ channelKind: 'im' }));
  assert.equal(r.reason, 'alias');
});

test('detects a reply in a thread I am part of', () => {
  const r = classifyCandidate(
    { user: 'U0X', text: 'any update?', ts: '1700000100.5', thread_ts: '1700000000.000100' },
    ctx()
  );
  assert.equal(r.reason, 'thread_reply');
});

test('ignores replies in threads I am not part of', () => {
  const r = classifyCandidate(
    { user: 'U0X', text: 'any update?', ts: '1700000100.5', thread_ts: '1699999999.999999' },
    ctx()
  );
  assert.equal(r, null);
});

test('flags @channel broadcasts as broadcast', () => {
  const r = classifyCandidate({ user: 'U0X', text: '<!channel> please fill this form', ts: '1.0' }, ctx());
  assert.deepEqual(r, { reason: 'broadcast', isBroadcast: true });
});

test('matches a configured alias without an @mention', () => {
  const r = classifyCandidate({ user: 'U0X', text: 'Alex, can you take the deploy?', ts: '1.0' }, ctx());
  assert.equal(r.reason, 'alias');
});

test('alias matching respects word boundaries', () => {
  const r = classifyCandidate({ user: 'U0X', text: 'the alexandria library is a car', ts: '1.0' }, ctx());
  assert.equal(r, null);
});

test('alias matching ignores code blocks and link URLs', () => {
  const r = classifyCandidate(
    { user: 'U0X', text: '```const al = 1```  <https://x.com/al|profile>', ts: '1.0' },
    ctx({ aliasMatcher: buildAliasMatcher(['al']) })
  );
  assert.equal(r, null);
});

test('skips my own chatter, joins and empty text', () => {
  assert.equal(classifyCandidate({ user: ME, text: 'just thinking out loud', ts: '1.0' }, ctx()), null);
  assert.equal(classifyCandidate({ user: ME, text: '<@U0OTHER> can you do this?', ts: '1.0' }, ctx()), null);
  assert.equal(classifyCandidate({ user: 'U0X', subtype: 'channel_join', text: 'joined', ts: '1.0' }, ctx()), null);
  assert.equal(classifyCandidate({ user: 'U0X', text: '   ', ts: '1.0' }, ctx()), null);
});

test('a message where I @mention myself is a self-assignment', () => {
  const r = classifyCandidate({ user: ME, text: `<@${ME}> update the pricing page by Friday`, ts: '1.0' }, ctx());
  assert.deepEqual(r, { reason: 'self', isBroadcast: false });
});

test('bot status echoes that merely repeat my name are ignored', () => {
  // Real case: a task bot posting "Alex is currently working on X".
  const r = classifyCandidate(
    { user: 'U0BOTUSER', bot_id: 'B01', text: 'Alex is currently working on the pricing page.', ts: '1.0' },
    ctx()
  );
  assert.equal(r, null, 'bot with a user id must still be treated as a bot');
});

test('a bot that @mentions me directly is a real task', () => {
  const r = classifyCandidate(
    { user: 'U0BOTUSER', bot_id: 'B01', text: `<@${ME}> you were assigned PROJ-42`, ts: '1.0' },
    ctx()
  );
  assert.equal(r.reason, 'mention');
});

test('bot broadcasts without a mention are still ignored', () => {
  const r = classifyCandidate({ bot_id: 'B01', text: '<!channel> deploy finished', ts: '1.0' }, ctx());
  assert.equal(r, null);
});

test('ignores unrelated channel chatter', () => {
  assert.equal(classifyCandidate({ user: 'U0X', text: 'lunch anyone?', ts: '1.0' }, ctx()), null);
});

test('no aliases configured means no alias matching', () => {
  const r = classifyCandidate(
    { user: 'U0X', text: 'Alex should know', ts: '1.0' },
    ctx({ aliasMatcher: buildAliasMatcher([]) })
  );
  assert.equal(r, null);
});

test('plainText strips slack markup', () => {
  assert.match(plainText('hey <@U0ME> see <https://a.b|the doc>'), /the doc/);
  assert.doesNotMatch(plainText('<@U0ME> hi'), /U0ME/);
});

test('extractLinks labels known services and dedupes', () => {
  const links = extractLinks(
    'spec <https://docs.google.com/document/d/1|Spec> and https://github.com/o/r/pull/7 and <https://docs.google.com/document/d/1>'
  );
  assert.equal(links.length, 2);
  assert.equal(links[0].label, 'Spec');
  assert.equal(links[1].label, 'GitHub PR');
});

test('extractLinks captures uploaded files by Slack permalink only', () => {
  const links = extractLinks({
    text: 'here is the deck',
    files: [
      {
        name: 'Q3-report.pdf',
        filetype: 'pdf',
        permalink: 'https://example.slack.com/files/U0ME/F123/q3-report.pdf',
        url_private: 'https://files.slack.com/files-pri/T1-F123/q3-report.pdf',
      },
    ],
  });

  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://example.slack.com/files/U0ME/F123/q3-report.pdf');
  assert.equal(links[0].label, 'PDF · Q3-report.pdf');
  assert.ok(
    !links.some((l) => l.url.includes('files-pri')),
    'the private download url must never be stored'
  );
});

test('extractLinks reads attachment blocks and dedupes against the text', () => {
  const links = extractLinks({
    text: 'see <https://docs.google.com/document/d/1|Spec>',
    attachments: [
      { title: 'Spec', title_link: 'https://docs.google.com/document/d/1' },   // duplicate
      { title: 'Design', from_url: 'https://figma.com/file/abc' },
    ],
  });

  assert.equal(links.length, 2);
  assert.equal(links[1].label, 'Design');
});

test('extractLinks still accepts a plain string', () => {
  assert.equal(extractLinks('see https://example.com/a')[0].url, 'https://example.com/a');
});

test('extractLinks copes with a message carrying no links at all', () => {
  assert.deepEqual(extractLinks({ text: 'no links here', files: [], attachments: [] }), []);
});

test('extractLinks trims trailing punctuation', () => {
  assert.equal(extractLinks('see https://example.com/a.')[0].url, 'https://example.com/a');
});

test('priority people override the model verdict', () => {
  const out = enrich(
    { text: 'small favour', sentAt: new Date('2026-08-05T10:00:00Z'), reason: 'mention', isBroadcast: false },
    { title: 'Do a small favour', priority: 'low', dueDate: null, category: 'other', confidence: 0.8, description: null },
    { isPriorityPerson: true, timezone: 'UTC' }
  );
  assert.equal(out.priority, 'high');
});

test('broadcasts are demoted to low and labelled', () => {
  const out = enrich(
    { text: '<!channel> fill the form', sentAt: new Date('2026-08-05T10:00:00Z'), reason: 'broadcast', isBroadcast: true },
    { title: 'Fill the form', priority: 'high', dueDate: null, category: 'admin', confidence: 0.9, description: null },
    { isPriorityPerson: true, timezone: 'UTC' }
  );
  assert.equal(out.priority, 'low');
  assert.equal(out.isBroadcast, 1);
  assert.equal(out.category, 'broadcast');
});

test('a due date before the message date is dropped', () => {
  const out = enrich(
    { text: 'do it', sentAt: new Date('2026-08-05T10:00:00Z'), reason: 'mention', isBroadcast: false },
    { title: 'Do it', priority: 'medium', dueDate: '2026-08-01', category: 'other', confidence: 0.7, description: null },
    { timezone: 'UTC' }
  );
  assert.equal(out.dueDate, null);
});

test('a missing verdict still produces a usable card', () => {
  const out = enrich(
    { text: 'hey can you look at the deploy\nsecond line', sentAt: new Date(), reason: 'dm', isBroadcast: false, assignerName: 'Alex' },
    null,
    { timezone: 'UTC' }
  );
  assert.equal(out.title, 'hey can you look at the deploy');
  assert.equal(out.priority, 'medium');
});

test('validateVerdict coerces junk into safe values', () => {
  const v = validateVerdict({ id: 'm1', title: 'Ship it', priority: 'URGENT', category: 'nonsense', due_date: 'next friday', confidence: 42 });
  assert.equal(v.priority, 'medium');
  assert.equal(v.category, 'other');
  assert.equal(v.dueDate, null);
  assert.equal(v.confidence, 1);
});

test('validateVerdict rejects objects without an id', () => {
  assert.equal(validateVerdict({ title: 'no id' }), null);
});

test('parseJsonArray handles fences and surrounding prose', () => {
  assert.equal(parseJsonArray('```json\n[{"id":"a"}]\n```')[0].id, 'a');
  assert.equal(parseJsonArray('Here you go:\n[{"id":"b"}]\nhope that helps')[0].id, 'b');
  assert.throws(() => parseJsonArray('no json at all'));
});

test('localDateString and daysUntil respect the timezone', () => {
  // 2026-08-05T20:00Z is already the 6th in Kolkata (+05:30).
  assert.equal(localDateString(new Date('2026-08-05T20:00:00Z'), 'Asia/Kolkata'), '2026-08-06');
  assert.equal(daysUntil(null, 'UTC'), null);
});

test('chunk splits batches', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});
