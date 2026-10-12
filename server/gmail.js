/**
 * Minimal Gmail client built on fetch. No SDK dependency, read-only scope.
 *
 * Email is the other place asks arrive, and it was the gap in a tool that
 * promised "you don't have to go looking": anything a customer or a manager
 * sent by mail still needed a trip to the inbox. This reads the mailbox the same
 * way slack.js reads Slack - deterministically, with no model involved - and
 * hands back plain objects the mail prefilter can judge for free.
 *
 * Kent asks Google for `gmail.readonly` and nothing else. It cannot send, label,
 * archive or delete mail, and there is no code path here that tries.
 *
 * Tokens: the refresh token lives in the Keychain (secrets.js); the short-lived
 * access token it buys is held in memory only and re-bought when it lapses.
 */
import { getGmailSecrets } from './secrets.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export class GmailError extends Error {
  constructor(code, detail, userMessage) {
    super(`Gmail ${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'GmailError';
    this.code = code;
    this.detail = detail;
    this.userMessage = userMessage ?? 'Gmail could not be reached. Kent will try again on the next sync.';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- OAuth

/** Where to send the browser so the user can grant read-only access. */
export function buildAuthUrl({ clientId, redirectUri, state, challenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Without both of these Google returns no refresh token on a second
    // consent, and the connection would die with the first access token.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(fields) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const code = data.error ?? `http_${res.status}`;
    throw new GmailError(
      code,
      data.error_description,
      code === 'invalid_grant'
        ? 'Gmail access has expired or was revoked. Reconnect Gmail in Settings.'
        : code === 'invalid_client'
          ? 'Google rejected the client ID or secret. Check them in Settings.'
          : undefined
    );
  }
  return data;
}

/** Trade the one-time code from the consent redirect for a refresh token. */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri, verifier }) {
  const data = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (!data.refresh_token) {
    throw new GmailError('no_refresh_token', null, 'Google did not grant ongoing access. Try connecting again.');
  }
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return { refreshToken: data.refresh_token };
}

let cached = null;

/** Forget the in-memory access token (on disconnect, or a 401). */
export const resetAccess = () => {
  cached = null;
};

async function accessToken() {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const secrets = getGmailSecrets();
  if (!secrets) throw new GmailError('not_configured', null, 'Connect Gmail in Settings first.');

  const data = await tokenRequest({
    client_id: secrets.clientId,
    client_secret: secrets.clientSecret,
    refresh_token: secrets.refreshToken,
    grant_type: 'refresh_token',
  });
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cached.token;
}

/** GET a Gmail API path. Honours 429 / 5xx with a short backoff, re-auths once on 401. */
async function get(path, params = {}, { retries = 3 } = {}) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    for (const item of Array.isArray(v) ? v : [v]) query.append(k, String(item));
  }
  const url = `${API}${path}${query.size ? `?${query}` : ''}`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });

    if (res.status === 401 && attempt === 0) {
      resetAccess();
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new GmailError(
        `http_${res.status}`,
        data?.error?.message,
        res.status === 403
          ? 'Google refused the request. Make sure the Gmail API is enabled for your Google Cloud project.'
          : undefined
      );
    }
    return res.json();
  }
}

// -------------------------------------------------------------------- reads

export async function getProfile() {
  const data = await get('/profile');
  return { address: String(data.emailAddress ?? '').toLowerCase() };
}

/** Messages per sync that are read in full; the rest wait for the next pass. */
export const READ_LIMIT = 150;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * Ids of inbox mail newer than `after` (epoch seconds), oldest first.
 *
 * Gmail lists newest first and offers no other order, so after a week away the
 * mail that has waited longest is on the last page. Every page is walked - ids
 * only, which is cheap - and the list is reversed, so a backlog is worked through
 * in the order it arrived and the cursor can advance behind it safely.
 */
export async function listMessageIds({ after }) {
  const ids = [];
  let pageToken;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await get('/messages', {
      q: `in:inbox after:${Math.max(0, Math.floor(after))}`,
      maxResults: PAGE_SIZE,
      pageToken,
    });
    for (const m of data.messages ?? []) ids.push({ id: m.id, threadId: m.threadId });
    pageToken = data.nextPageToken;
    if (!pageToken) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  return { ids: ids.reverse(), truncated };
}

export async function getMessage(id) {
  return parseMessage(await get(`/messages/${id}`, { format: 'full' }));
}

/** Who said what when in a thread, without the bodies. */
export async function getThreadMeta(threadId) {
  const data = await get(`/threads/${threadId}`, { format: 'minimal' });
  return (data.messages ?? []).map((m) => ({
    id: m.id,
    labelIds: m.labelIds ?? [],
    internalDate: Number(m.internalDate),
  }));
}

/** A link that opens the conversation in Gmail's own UI. */
export const threadUrl = (threadId) => `https://mail.google.com/mail/u/0/#all/${threadId}`;

// ------------------------------------------------------------------ parsing

const decode = (data) => Buffer.from(String(data ?? ''), 'base64url').toString('utf8');

/** "Alex Nair <alex@example.com>" -> { name, email }. */
export function parseAddress(value = '') {
  const text = String(value).trim();
  const angle = text.match(/^(.*?)<([^>]+)>\s*$/);
  const email = (angle ? angle[2] : text).trim().toLowerCase();
  const name = angle ? angle[1].trim().replace(/^"|"$/g, '').trim() : '';
  return { name: name || email.split('@')[0], email };
}

/** A To/Cc header as a list of lower-cased addresses. Commas inside quotes are not separators. */
export function parseAddressList(value = '') {
  return String(value)
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => parseAddress(part).email)
    .filter((email) => email.includes('@'));
}

function htmlToText(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** The readable body: text/plain if the sender included one, else the HTML flattened. */
function bodyText(payload) {
  let plain = '';
  let html = '';
  let hasCalendar = false;
  const attachments = [];

  (function walk(part) {
    if (!part) return;
    const mime = part.mimeType ?? '';
    if (part.filename) attachments.push(part.filename);
    else if (mime === 'text/plain' && part.body?.data) plain += decode(part.body.data);
    else if (mime === 'text/html' && part.body?.data) html += decode(part.body.data);
    if (mime === 'text/calendar') hasCalendar = true;
    for (const child of part.parts ?? []) walk(child);
  })(payload);

  return { text: plain.trim() || htmlToText(html).trim(), attachments, hasCalendar };
}

/**
 * Cut an email down to what its sender wrote this time.
 *
 * A reply carries every earlier message underneath it. Left in, the model reads
 * a request from three emails ago as if it had just been made, and one thread
 * turns into the same task several times over.
 */
export function stripQuoted(text = '') {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^On .{0,200}wrote:\s*$/i.test(line.trim())) break;
    if (/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}$/i.test(line.trim())) break;
    // Outlook's header block: "From: ..." directly followed by "Sent: ...".
    if (/^From:\s.+/i.test(line) && out.length > 0 && /^(Sent|Date):\s/i.test(lines[i + 1] ?? '')) break;
    if (/^_{10,}$/.test(line.trim())) break;
    if (line.trimStart().startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Longest body handed onward. Beyond this an email is an attachment, not an ask. */
const MAX_BODY = 2000;

/** Shape a raw Gmail message into what the prefilter and the queue need. */
export function parseMessage(raw) {
  const headers = new Map(
    (raw?.payload?.headers ?? []).map((h) => [String(h.name).toLowerCase(), String(h.value ?? '')])
  );
  const { text, attachments, hasCalendar } = bodyText(raw?.payload);
  const body = stripQuoted(text).slice(0, MAX_BODY);
  const subject = (headers.get('subject') ?? '').trim();

  return {
    id: raw.id,
    threadId: raw.threadId,
    labelIds: raw.labelIds ?? [],
    internalDate: Number(raw.internalDate) || Date.now(),
    from: parseAddress(headers.get('from')),
    to: parseAddressList(headers.get('to')),
    cc: parseAddressList(headers.get('cc')),
    subject,
    body,
    attachments,
    hasCalendar,
    // The automation tells: who sends mail with these never expects a reply.
    listUnsubscribe: headers.has('list-unsubscribe'),
    listId: headers.has('list-id'),
    precedence: (headers.get('precedence') ?? '').toLowerCase(),
    autoSubmitted: (headers.get('auto-submitted') ?? '').toLowerCase(),
    // What the model reads and what the card quotes.
    text: `Subject: ${subject || '(no subject)'}\n\n${body}`.trim(),
  };
}
