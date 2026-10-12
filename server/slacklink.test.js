/**
 * Telling a link to one Slack message from everything else that gets pasted.
 *
 * The check runs before anything is sent to Slack, so each "not a message"
 * case here is a request that never happens and an error that says what to do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlackLink } from './slacklink.js';

const TEAM = { teamDomain: 'https://acme.slack.com/' };

test('a message link gives the channel and the exact timestamp', () => {
  const link = parseSlackLink('https://acme.slack.com/archives/C0123ABCD/p1720000000000200', TEAM);
  assert.deepEqual(link, {
    ok: true,
    channelId: 'C0123ABCD',
    ts: '1720000000.000200',
    threadTs: null,
    url: 'https://acme.slack.com/archives/C0123ABCD/p1720000000000200',
  });
});

test('a link to a reply carries the thread it belongs to', () => {
  const link = parseSlackLink(
    'https://acme.slack.com/archives/C0123ABCD/p1720000000000300?thread_ts=1720000000.000200&cid=C0123ABCD',
    TEAM
  );
  assert.equal(link.ts, '1720000000.000300');
  assert.equal(link.threadTs, '1720000000.000200');
});

test('DMs and private channels are message links too', () => {
  assert.ok(parseSlackLink('https://acme.slack.com/archives/D0123ABCD/p1720000000000200', TEAM).ok);
  assert.ok(parseSlackLink('https://acme.slack.com/archives/G0123ABCD/p1720000000000200', TEAM).ok);
});

test('whitespace, Slack’s own angle brackets and tracking junk are tolerated', () => {
  const link = parseSlackLink('  <https://acme.slack.com/archives/C0123ABCD/p1720000000000200?utm_source=x>  ', TEAM);
  assert.equal(link.ok, true);
  assert.equal(link.url, 'https://acme.slack.com/archives/C0123ABCD/p1720000000000200', 'only the checked parts are kept');
});

const NOT_MESSAGE = [
  ['a channel, not a message', 'https://acme.slack.com/archives/C0123ABCD'],
  ['a file', 'https://acme.slack.com/files/U0123/F0456/report.pdf'],
  ['the web client view', 'https://app.slack.com/client/T0123/C0123ABCD'],
  ['a truncated timestamp', 'https://acme.slack.com/archives/C0123ABCD/p17200000'],
  ['a user id where the channel should be', 'https://acme.slack.com/archives/U0123ABCD/p1720000000000200'],
  ['extra path segments', 'https://acme.slack.com/archives/C0123ABCD/p1720000000000200/extra'],
];
for (const [name, url] of NOT_MESSAGE) {
  test(`refused as not a single message: ${name}`, () => {
    assert.equal(parseSlackLink(url, TEAM).code, 'not_message');
  });
}

const NOT_SLACK = [
  ['another site entirely', 'https://docs.google.com/document/d/abc'],
  ['a lookalike host', 'https://acme.slack.com.evil.example/archives/C0123ABCD/p1720000000000200'],
  ['a host that only ends in the letters', 'https://notslack.com/archives/C0123ABCD/p1720000000000200'],
  ['plain http', 'http://acme.slack.com/archives/C0123ABCD/p1720000000000200'],
  ['credentials smuggled into the URL', 'https://acme.slack.com@evil.example/archives/C0123ABCD/p1720000000000200'],
];
for (const [name, url] of NOT_SLACK) {
  test(`refused as not Slack: ${name}`, () => {
    assert.equal(parseSlackLink(url, TEAM).code, 'not_slack');
  });
}

test('text that is not a link at all says so', () => {
  assert.equal(parseSlackLink('remind me about the deck', TEAM).code, 'not_url');
  assert.equal(parseSlackLink('', TEAM).code, 'not_url');
  assert.equal(parseSlackLink(null, TEAM).code, 'not_url');
});

test('a message in another workspace is refused before Slack is asked', () => {
  const link = parseSlackLink('https://other.slack.com/archives/C0123ABCD/p1720000000000200', TEAM);
  assert.equal(link.code, 'other_workspace');
});

test('with no workspace known yet, any Slack workspace is accepted', () => {
  assert.ok(parseSlackLink('https://other.slack.com/archives/C0123ABCD/p1720000000000200').ok);
});

test('every refusal comes with a sentence a person can act on', () => {
  for (const url of ['nope', 'https://example.com', 'https://acme.slack.com/archives/C0123ABCD']) {
    assert.ok(parseSlackLink(url, TEAM).error.length > 20);
  }
});
