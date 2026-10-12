/**
 * Turning what Gmail returns into something a prefilter and a model can read.
 *
 * The part that matters most is cutting a reply down to what was written this
 * time: with the quoted history left in, an ask from three emails ago is read
 * as new, and one thread becomes the same task again on every reply.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthUrl, parseAddress, parseAddressList, parseMessage, stripQuoted, SCOPE } from './gmail.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');
const header = (name, value) => ({ name, value });

test('an address is split into a display name and a lower-cased email', () => {
  assert.deepEqual(parseAddress('Priya Shah <Priya@Client.com>'), { name: 'Priya Shah', email: 'priya@client.com' });
  assert.deepEqual(parseAddress('"Shah, Priya" <priya@client.com>'), { name: 'Shah, Priya', email: 'priya@client.com' });
  assert.deepEqual(parseAddress('priya@client.com'), { name: 'priya', email: 'priya@client.com' });
});

test('a recipient list survives a comma inside a quoted name', () => {
  assert.deepEqual(
    parseAddressList('"Shah, Priya" <priya@client.com>, Me <me@example.com>, undisclosed-recipients:;'),
    ['priya@client.com', 'me@example.com']
  );
});

test('a reply is cut at the quoted history', () => {
  const body = [
    'Thanks - can you also attach the DPA?',
    '',
    'On Fri, 7 Aug 2026 at 12:10, Me <me@example.com> wrote:',
    '> Here is the quote you asked for.',
    '> Could you confirm by Monday?',
  ].join('\r\n');
  assert.equal(stripQuoted(body), 'Thanks - can you also attach the DPA?');
});

test('Outlook-style and forwarded history is cut too', () => {
  assert.equal(
    stripQuoted('Please review.\n\nFrom: Alex Nair\nSent: Friday, 7 August 2026 10:00\nTo: Me\nSubject: old\n\nold text'),
    'Please review.'
  );
  assert.equal(stripQuoted('See below.\n\n-----Original Message-----\nold'), 'See below.');
});

test('inline > quotes are dropped without losing the reply around them', () => {
  assert.equal(stripQuoted('Yes to this:\n> can we ship Friday?\nBut send me the checklist first.'),
    'Yes to this:\nBut send me the checklist first.');
});

test('a "From:" line in ordinary prose does not truncate the message', () => {
  const text = 'Notes from the call.\nFrom: what I heard, they want it by Friday.\nPlease prepare the deck.';
  assert.equal(stripQuoted(text), text);
});

test('a multipart message yields its plain text, headers and attachments', () => {
  const mail = parseMessage({
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX'],
    internalDate: '1786430400000',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        header('From', 'Priya Shah <priya@client.com>'),
        header('To', 'me@example.com, other@example.com'),
        header('Cc', 'boss@example.com'),
        header('Subject', 'Renewal quote'),
        header('List-Unsubscribe', '<mailto:x@y>'),
      ],
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('Could you send the quote by Wednesday?\n\n> old stuff') } },
            { mimeType: 'text/html', body: { data: b64('<p>ignored when plain text exists</p>') } },
          ],
        },
        { mimeType: 'application/pdf', filename: 'quote-v1.pdf', body: { attachmentId: 'a1' } },
      ],
    },
  });

  assert.equal(mail.from.email, 'priya@client.com');
  assert.deepEqual(mail.to, ['me@example.com', 'other@example.com']);
  assert.deepEqual(mail.cc, ['boss@example.com']);
  assert.equal(mail.body, 'Could you send the quote by Wednesday?');
  assert.equal(mail.text, 'Subject: Renewal quote\n\nCould you send the quote by Wednesday?');
  assert.deepEqual(mail.attachments, ['quote-v1.pdf']);
  assert.equal(mail.listUnsubscribe, true);
  assert.equal(mail.internalDate, 1786430400000);
});

test('an HTML-only message is flattened to text', () => {
  const mail = parseMessage({
    id: 'm2',
    threadId: 't2',
    payload: {
      mimeType: 'text/html',
      headers: [header('Subject', 'Hi')],
      body: { data: b64('<style>p{color:red}</style><p>Please <b>review</b> the deck &amp; reply.</p><p>Thanks</p>') },
    },
  });
  assert.match(mail.body, /Please\s+review\s+the deck & reply\./);
  assert.ok(!mail.body.includes('color:red'), 'style blocks are not content');
});

test('a calendar invitation is flagged so the prefilter can leave it alone', () => {
  const mail = parseMessage({
    id: 'm3',
    threadId: 't3',
    payload: { mimeType: 'multipart/mixed', headers: [], parts: [{ mimeType: 'text/calendar', body: { data: b64('BEGIN:VCALENDAR') } }] },
  });
  assert.equal(mail.hasCalendar, true);
});

test('a very long email is capped before it reaches the model', () => {
  const mail = parseMessage({
    id: 'm4',
    threadId: 't4',
    payload: { mimeType: 'text/plain', headers: [], body: { data: b64('word '.repeat(5000)) } },
  });
  assert.ok(mail.body.length <= 2000);
});

test('the consent URL asks for read-only access and nothing more', () => {
  const url = new URL(buildAuthUrl({
    clientId: 'id.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:4317/api/gmail/callback',
    state: 'S',
    challenge: 'C',
  }));
  assert.equal(SCOPE, 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(url.searchParams.get('scope'), SCOPE);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:4317/api/gmail/callback');
});
