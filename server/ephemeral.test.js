/**
 * The "already over by now" rule.
 *
 * Every case here is a real shape of Slack message. The ones that must survive
 * matter more than the ones that must be dropped: a false negative costs one
 * card of noise, a false positive silently eats someone's work.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { looksEphemeral } from './ephemeral.js';

test('an ask measured in minutes is not a task', () => {
  // The message that prompted this rule.
  assert.equal(looksEphemeral('<@U1> can you join the meeting for 2 minutes?'), true);
  assert.equal(looksEphemeral('hop on the huddle real quick?'), true);
  assert.equal(looksEphemeral('we are in the standup now, can you join'), true);
  assert.equal(looksEphemeral('jump on the call asap'), true);
  assert.equal(looksEphemeral('<@U1> come over for a min'), true);
});

test('a meeting with a date and something to bring is real work', () => {
  assert.equal(
    looksEphemeral('can you join the vendor review on Friday and present the cost breakdown?', {
      hasDeadline: true,
    }),
    false
  );
  // Even with no deadline parsed, nothing here says "right now".
  assert.equal(
    looksEphemeral('can you join the design review and walk through the metrics?'),
    false
  );
});

test('work that merely sounds urgent is untouched', () => {
  // No "be somewhere" verb, so urgency alone never drops a message.
  assert.equal(looksEphemeral('meeting notes needed asap'), false);
  assert.equal(looksEphemeral('<@U1> can you fix the login bug quickly'), false);
  assert.equal(looksEphemeral('we need the deck right now'), false);
  assert.equal(looksEphemeral('<@U1> please review the PR, it is blocking the release'), false);
});

test('a long message is left to the model', () => {
  const detailed =
    'can you join the incident call now — also please pull the error rates for the last 6 hours, ' +
    'check whether the rollback landed, and write up what happened for the postmortem doc';
  assert.equal(looksEphemeral(detailed), false, 'there is real work buried in it');
});

test('a stated deadline always wins', () => {
  assert.equal(looksEphemeral('join the call now', { hasDeadline: true }), false);
});

test('empty and junk input is not a task either way', () => {
  assert.equal(looksEphemeral(''), false);
  assert.equal(looksEphemeral(null), false);
  assert.equal(looksEphemeral('<@U1> <https://example.com>'), false);
});
