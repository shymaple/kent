/**
 * Slack markup rendering.
 *
 * The rule under test: a raw member id must never reach the screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kent-render-'));
process.env.MYBOT_DB = join(dir, 'test.db');
process.env.MYBOT_NO_KEYCHAIN = '1';

const { db } = await import('./db.js');

db.prepare("INSERT INTO people (slack_user_id, display_name) VALUES ('U01ABC23DEF', 'Sam')").run();
db.prepare("INSERT INTO people (slack_user_id, display_name) VALUES ('U02XYZ45GHI', 'Robin')").run();
db.prepare("INSERT INTO channels (id, name, kind) VALUES ('C0GEN', 'general', 'channel')").run();

const { renderSlackText, renderConversationName, humaniseHandle } = await import('./render.js');

test("a member id becomes the person's name", () => {
  assert.equal(
    renderSlackText('Hi <@U01ABC23DEF> - Dana has approved those 2 pages'),
    'Hi @Sam - Dana has approved those 2 pages'
  );
});

test('several mentions in one message all resolve', () => {
  assert.equal(
    renderSlackText('<@U01ABC23DEF> and <@U02XYZ45GHI> please sync'),
    '@Sam and @Robin please sync'
  );
});

test('an unknown id degrades gracefully instead of leaking the raw id', () => {
  const out = renderSlackText('ping <@U0NOTKNOWN> about it');
  assert.equal(out, 'ping @someone about it');
  assert.ok(!out.includes('U0NOTKNOWN'), 'no raw member id may survive');
});

test('an inline label on a mention wins over the lookup', () => {
  assert.equal(renderSlackText('<@U02XYZ45GHI|robin.d> hi'), '@robin.d hi');
});

test('channel references, broadcasts and user groups render', () => {
  assert.equal(renderSlackText('see <#C0GEN|general>'), 'see #general');
  assert.equal(renderSlackText('see <#C0GEN>'), 'see #general');
  assert.equal(renderSlackText('<!channel> heads up'), '@channel heads up');
  assert.equal(renderSlackText('<!here> quick one'), '@here quick one');
  assert.equal(renderSlackText('<!subteam^S123|@design> take a look'), '@design take a look');
});

test('links keep their label, bare links keep their url', () => {
  assert.equal(renderSlackText('spec <https://docs.google.com/d/1|Spec>'), 'spec Spec');
  assert.equal(renderSlackText('see <https://example.com/a>'), 'see https://example.com/a');
});

test('slack entity escapes are undone', () => {
  assert.equal(renderSlackText('Tom &amp; Jerry &lt;3'), 'Tom & Jerry <3');
});

test('empty and null input are safe', () => {
  assert.equal(renderSlackText(''), '');
  assert.equal(renderSlackText(null), '');
  assert.equal(renderSlackText(undefined), '');
});

test('a group DM name becomes readable, without me in it', () => {
  const name = renderConversationName(
    { name: 'mpdm-alex.chen--jordan.blake--sam.rivera-1', kind: 'mpim' },
    'sam.rivera'
  );
  assert.equal(name, 'Alex Chen, Jordan Blake');
});

test('a long group DM is truncated with a count', () => {
  const name = renderConversationName(
    { name: 'mpdm-a.one--b.two--c.three--d.four--e.five--sam.rivera-1', kind: 'mpim' },
    'sam.rivera'
  );
  assert.equal(name, 'A One, B Two, C Three +2');
});

test('group DM naming works from a bare string too', () => {
  // Tasks carry channel_name without the kind, so the pattern has to be enough.
  assert.equal(renderConversationName('mpdm-robin--dana-1', 'sam.rivera'), 'Robin, Dana');
});

test('ordinary channel and DM names are left alone', () => {
  assert.equal(renderConversationName({ name: 'team-marketing', kind: 'private' }), 'team-marketing');
  assert.equal(renderConversationName({ name: '@Robin', kind: 'im' }), '@Robin');
});

test('humaniseHandle title-cases dotted handles', () => {
  assert.equal(humaniseHandle('alex.chen'), 'Alex Chen');
  assert.equal(humaniseHandle('dana'), 'Dana');
});

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
