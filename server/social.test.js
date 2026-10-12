/**
 * The line between being spoken to and being given work.
 *
 * Each case here is a message that really does @mention the user. The first
 * group must never reach the board; the second mentions the same lunches and
 * dinners and must always survive, because the ask in it is a job.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { looksSocial } from './social.js';

const SOCIAL = [
  '<@U0ME> how are you?',
  '<@U0ME> hey, how are you doing today?',
  '<@U0ME> good morning!',
  '<@U0ME> good morning! how was the weekend?',
  '<@U0ME> are you coming for lunch?',
  '<@U0ME> lunch?',
  '<@U0ME> coffee in 10?',
  '<@U0ME> are you joining the team dinner on Friday?',
  '<@U0ME> up for chai?',
  "<@U0ME> let's grab drinks after work",
  '<@U0ME> happy birthday!! :tada:',
  '<@U0ME> congrats on the promotion 🎉',
  '<@U0ME> thanks a lot!',
  '<@U0ME> what’s up'.replace('’', "'"),
  '<@U0ME> welcome back',
];

const WORK = [
  '<@U0ME> can you book the venue for the team dinner on Friday?',
  '<@U0ME> can you order lunch for the client visit tomorrow',
  '<@U0ME> we have the lunch-and-learn on Thursday, can you present the Q3 roadmap?',
  '<@U0ME> hey, how are you? when you get time please update the pricing sheet',
  '<@U0ME> can you review the onboarding copy before the Thursday sync?',
  '<@U0ME> thanks! can you also send the invoice to finance',
  '<@U0ME> how are you placed to take the vendor audit this week?',
  '<@U0ME> please fill the dinner headcount form by EOD',
  '<@U0ME> prod checkout is throwing 500s, need this fixed today',
  '<@U0ME> coffee machine vendor contract needs your sign-off',
];

for (const text of SOCIAL) {
  test(`social, not work: ${text}`, () => {
    assert.equal(looksSocial(text), true);
  });
}

for (const text of WORK) {
  test(`work that must survive: ${text}`, () => {
    assert.equal(looksSocial(text), false);
  });
}

test('a link or a file means someone sent you something to act on', () => {
  assert.equal(looksSocial('<@U0ME> lunch?', { hasLinks: true }), false);
});

test('a long message is left to the model, whatever it mentions', () => {
  const long = `<@U0ME> are you coming for lunch? ${'also a few things from the standup that we should talk through. '.repeat(3)}`;
  assert.equal(looksSocial(long), false);
});

test('empty and missing text is not social, it is nothing', () => {
  assert.equal(looksSocial(''), false);
  assert.equal(looksSocial(null), false);
});
