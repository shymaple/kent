/**
 * Which emails are worth a model call.
 *
 * The cases are the inbox as it actually is: a few people asking for things,
 * buried under mail that no one would call a task. The second kind has to be
 * dropped here, for free, or every sync pays the model to read newsletters.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMail } from './mailfilter.js';
import { buildAliasMatcher } from './prefilter.js';

const ME = 'me@example.com';
const ctx = { myAddress: ME, aliasMatcher: buildAliasMatcher(['Mahendra']) };

const mail = (over = {}) => ({
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX', 'UNREAD'],
  from: { name: 'Priya Shah', email: 'priya@client.com' },
  to: [ME],
  cc: [],
  subject: 'Renewal quote',
  body: 'Could you send the revised quote by Wednesday?',
  listUnsubscribe: false,
  listId: false,
  precedence: '',
  autoSubmitted: '',
  hasCalendar: false,
  ...over,
});

test('mail addressed straight to me is a candidate', () => {
  assert.deepEqual(classifyMail(mail(), ctx), { reason: 'email_to', isBroadcast: false });
});

test('my address is matched whatever its case', () => {
  assert.ok(classifyMail(mail(), { ...ctx, myAddress: 'Me@Example.com' }));
});

test('being cc’d is not being asked', () => {
  assert.equal(classifyMail(mail({ to: ['boss@example.com'], cc: [ME] }), ctx), null);
});

test('being cc’d counts once the message names me', () => {
  const hit = classifyMail(
    mail({ to: ['boss@example.com'], cc: [ME], body: 'Mahendra, can you pick this one up?' }),
    ctx
  );
  assert.deepEqual(hit, { reason: 'email_cc', isBroadcast: false });
});

test('mail to a long list of people is kept, but as a low-value broadcast', () => {
  const to = [ME, ...Array.from({ length: 9 }, (_, i) => `p${i}@example.com`)];
  assert.deepEqual(classifyMail(mail({ to }), ctx), { reason: 'email_to', isBroadcast: true });
});

test('my own mail is never a candidate', () => {
  assert.equal(classifyMail(mail({ from: { name: 'Me', email: ME } }), ctx), null);
  assert.equal(classifyMail(mail({ labelIds: ['SENT'] }), ctx), null);
});

for (const label of ['SPAM', 'TRASH', 'DRAFT', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']) {
  test(`mail Gmail filed under ${label} is skipped`, () => {
    assert.equal(classifyMail(mail({ labelIds: ['INBOX', label] }), ctx), null);
  });
}

test('anything with an unsubscribe header is a mailing, not a request', () => {
  assert.equal(classifyMail(mail({ listUnsubscribe: true }), ctx), null);
  assert.equal(classifyMail(mail({ listId: true }), ctx), null);
  assert.equal(classifyMail(mail({ precedence: 'bulk' }), ctx), null);
});

test('auto-generated mail is skipped, but "Auto-Submitted: no" is a person', () => {
  assert.equal(classifyMail(mail({ autoSubmitted: 'auto-replied' }), ctx), null);
  assert.ok(classifyMail(mail({ autoSubmitted: 'no' }), ctx));
});

for (const sender of ['no-reply@github.com', 'noreply@bank.com', 'notifications@jira.example.com', 'mailer-daemon@googlemail.com', 'newsletter@vendor.io']) {
  test(`a robot sender is skipped: ${sender}`, () => {
    assert.equal(classifyMail(mail({ from: { name: 'Robot', email: sender } }), ctx), null);
  });
}

test('a person whose address merely starts like a robot is still a person', () => {
  // "news" must not swallow "newton@", nor "alert" swallow "alberta@".
  assert.ok(classifyMail(mail({ from: { name: 'Info Desk', email: 'info@smallvendor.com' } }), ctx));
  assert.ok(classifyMail(mail({ from: { name: 'Al', email: 'alberta@client.com' } }), ctx));
});

test('calendar invitations are left to the calendar', () => {
  assert.equal(classifyMail(mail({ hasCalendar: true }), ctx), null);
});

test('nothing is a candidate until the mailbox owner is known', () => {
  assert.equal(classifyMail(mail(), { myAddress: '' }), null);
  assert.equal(classifyMail(null, ctx), null);
});
