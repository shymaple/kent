/**
 * Deadline parsing.
 *
 * Anchored on Saturday 2026-08-08 unless stated. The false-positive tests matter
 * as much as the rest: a wrong deadline on a card is worse than none, because it
 * shows up as overdue and erodes trust in every other date.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeadline } from './deadline.js';

const SAT = new Date('2026-08-08T10:00:00Z');        // Saturday
const TUE = new Date('2026-08-11T10:00:00Z');        // Tuesday
const on = (text, date = SAT, tz = 'UTC') => parseDeadline(text, date, tz);

test('the case that started this: a weekday inside a noun phrase', () => {
  assert.equal(on('we need the pricing page updated before the review on Thursday'), '2026-08-13');
});

test('weekday names resolve to the next occurrence', () => {
  assert.equal(on('can you do this by Monday'), '2026-08-10');
  assert.equal(on('due Friday please'), '2026-08-14');
  assert.equal(on('sometime Sunday works'), '2026-08-09');
});

test('the same weekday as today means today', () => {
  assert.equal(on('needs doing by Saturday'), '2026-08-08');
});

test('"next <weekday>" means the following week', () => {
  assert.equal(on('let us ship it next Thursday'), '2026-08-20');
  assert.equal(on('this Thursday'), '2026-08-13');
});

test('tomorrow, today and end-of-day', () => {
  assert.equal(on('please review by tomorrow'), '2026-08-09');
  assert.equal(on('need it today'), '2026-08-08');
  assert.equal(on('can you get it done EOD'), '2026-08-08');
  assert.equal(on('by end of day please'), '2026-08-08');
  assert.equal(on('day after tomorrow is fine'), '2026-08-10');
});

test('end of week and end of month', () => {
  assert.equal(on('wrap up by end of the week'), '2026-08-14');   // Friday
  assert.equal(on('submit before end of month'), '2026-08-31');
});

test('explicit dates, with the year inferred forward', () => {
  assert.equal(on('please create the post by 28 August'), '2026-08-28');
  assert.equal(on('due August 28th'), '2026-08-28');
  assert.equal(on('deadline is 2026-09-15'), '2026-09-15');
  // February has already passed on 8 August, so it means next year.
  assert.equal(on('the audit is due 3 February'), '2027-02-03');
});

test('relative counts', () => {
  assert.equal(on('can you do it in 3 days'), '2026-08-11');
  assert.equal(on('in 2 weeks would be great'), '2026-08-22');
});

test('"next week" is the Monday that starts it, from any day', () => {
  assert.equal(on('let us pick this up next week'), '2026-08-10');
  assert.equal(on('let us pick this up next week', TUE), '2026-08-17');
});

test('no date wording means no deadline', () => {
  assert.equal(on('can you review the onboarding copy'), null);
  assert.equal(on('this needs updating before we ship'), null);
  assert.equal(on(''), null);
  assert.equal(on(null), null);
});

test('weekday abbreviations only count behind a cue word', () => {
  // The whole reason abbreviations are gated - these are ordinary prose.
  assert.equal(on('I sat down and read it'), null);
  assert.equal(on('they wed last summer'), null);
  assert.equal(on('the sun is out'), null);
  // With a cue, they are real.
  assert.equal(on('please finish by fri'), '2026-08-14');
  assert.equal(on('due mon'), '2026-08-10');
});

test('dates inside links and code are ignored', () => {
  assert.equal(on('see <https://example.com/2026-09-15/report>'), null);
  assert.equal(on('the constant is `MONDAY_OFFSET`'), null);
});

test('impossible and out-of-range dates are rejected', () => {
  assert.equal(on('due 31 February'), null);
  assert.equal(on('scheduled for 2019-01-01'), null, 'a past date is a misread');
  assert.equal(on('due 2030-01-01'), null, 'too far out to be a real deadline');
});

test('timezone decides which day "tomorrow" is', () => {
  // 20:00 UTC on the 8th is already the 9th in Kolkata, so tomorrow is the 10th.
  const late = new Date('2026-08-08T20:00:00Z');
  assert.equal(parseDeadline('finish by tomorrow', late, 'UTC'), '2026-08-09');
  assert.equal(parseDeadline('finish by tomorrow', late, 'Asia/Kolkata'), '2026-08-10');
});

test('an invalid send date yields nothing rather than throwing', () => {
  assert.equal(parseDeadline('by Friday', new Date('nonsense'), 'UTC'), null);
  assert.equal(parseDeadline('by Friday', 'not a date', 'UTC'), null);
});
