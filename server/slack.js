/**
 * Minimal Slack Web API client built on fetch. No SDK dependency.
 * Everything here is deterministic - no LLM involvement.
 */
import { getSlackToken } from './secrets.js';

const BASE = 'https://slack.com/api';

export class SlackError extends Error {
  constructor(method, code) {
    super(`Slack ${method} failed: ${code}`);
    this.name = 'SlackError';
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scopes Kent needs on a user token, and what breaks without each. */
export const REQUIRED_SCOPES = {
  'channels:history': 'read messages in public channels',
  'channels:read': 'list the public channels you are in',
  'groups:history': 'read messages in private channels',
  'groups:read': 'list the private channels you are in',
  'im:history': 'read your DMs',
  'im:read': 'list your DMs',
  'mpim:history': 'read your group DMs',
  'mpim:read': 'list your group DMs',
  'users:read': 'show teammate names and populate the priority list',
  'team:read': 'build message permalinks',
};

/** Optional: only needed to post replies. Absence is reported, not treated as broken. */
export const OPTIONAL_SCOPES = {
  'chat:write': 'reply in the Slack thread when you finish a task',
};

/**
 * Slack reports what the token actually holds in this header on every response.
 * We keep the latest value so Settings can show exactly what is missing.
 */
let grantedScopes = null;
export const getGrantedScopes = () => grantedScopes;

/**
 * Call a Slack method. Handles 429 with Retry-After, retries transient 5xx.
 * Slack's read methods are Tier 3 (~50/min), so honouring Retry-After is enough.
 */
export async function call(method, params = {}, { token = getSlackToken(), retries = 4 } = {}) {
  if (!token) throw new SlackError(method, 'not_configured');

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) body.set(k, String(v));
  }

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body,
    });

    if (res.status === 429 && attempt < retries) {
      const wait = Number(res.headers.get('retry-after') || 5);
      await sleep((wait + 1) * 1000);
      continue;
    }
    if (res.status >= 500 && attempt < retries) {
      await sleep(2 ** attempt * 500);
      continue;
    }

    const header = res.headers.get?.('x-oauth-scopes');
    if (header) grantedScopes = header.split(',').map((s) => s.trim()).filter(Boolean);

    const json = await res.json();
    if (!json.ok) {
      const err = new SlackError(method, json.error || `http_${res.status}`);
      if (json.needed) err.needed = String(json.needed).split(',').map((s) => s.trim());
      if (json.provided) err.provided = String(json.provided).split(',').map((s) => s.trim());
      throw err;
    }
    return json;
  }
}

/** Walk a cursor-paginated method, yielding each page's items. */
async function* paginate(method, params, itemsKey, opts) {
  let cursor;
  do {
    const json = await call(method, { ...params, cursor, limit: params.limit ?? 200 }, opts);
    yield json[itemsKey] ?? [];
    cursor = json.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

/** Who am I? Also gives the workspace domain used to build message permalinks. */
export async function authTest(opts) {
  const json = await call('auth.test', {}, opts);
  return {
    userId: json.user_id,
    user: json.user,
    teamId: json.team_id,
    team: json.team,
    url: json.url,
  };
}

/**
 * Full health check of whatever token is configured: who it belongs to, whether
 * it is a bot or a user token, and which required scopes are missing.
 * Never throws - the whole point is to report problems.
 */
export async function diagnose(opts) {
  const result = {
    ok: false,
    tokenType: null,      // 'user' | 'bot' | 'unknown'
    identity: null,
    isBotToken: false,
    grantedScopes: [],
    missingScopes: [],
    problems: [],
  };

  let json;
  try {
    json = await call('auth.test', {}, opts);
  } catch (err) {
    result.problems.push(
      err.code === 'not_configured'
        ? 'No Slack token is configured yet.'
        : `Slack rejected the token: ${err.code}. Reinstall the app and copy the token again.`
    );
    return result;
  }

  result.identity = { user: json.user, userId: json.user_id, team: json.team, url: json.url };
  result.isBotToken = Boolean(json.bot_id);
  result.tokenType = json.bot_id ? 'bot' : 'user';

  if (result.isBotToken) {
    result.problems.push(
      `This is a bot token — Slack sees it as "${json.user}", not as you. Kent cannot detect @mentions of you, ` +
        'cannot read your DMs, and only sees channels the bot has been invited to. ' +
        'Reinstall the app with user scopes and use the User OAuth Token (xoxp-…).'
    );
  }

  result.grantedScopes = getGrantedScopes() ?? [];
  result.missingScopes = Object.keys(REQUIRED_SCOPES).filter((s) => !result.grantedScopes.includes(s));
  result.missingOptional = Object.keys(OPTIONAL_SCOPES).filter((s) => !result.grantedScopes.includes(s));
  result.canReply = !result.missingOptional.includes('chat:write');

  if (result.missingScopes.length) {
    result.problems.push(
      `Missing ${result.missingScopes.length} scope(s): ${result.missingScopes.join(', ')}. ` +
        'Add them under OAuth & Permissions, then reinstall the app — scope changes only apply on reinstall.'
    );
  }

  result.ok = result.problems.length === 0;
  return result;
}

const KIND = (c) => {
  if (c.is_im) return 'im';
  if (c.is_mpim) return 'mpim';
  if (c.is_private) return 'private';
  return 'channel';
};

/** Every conversation the authed user is a member of, including DMs. */
export async function listMyConversations(opts) {
  const out = [];
  const params = {
    types: 'public_channel,private_channel,mpim,im',
    exclude_archived: true,
    limit: 200,
  };
  for await (const page of paginate('users.conversations', params, 'channels', opts)) {
    for (const c of page) {
      out.push({
        id: c.id,
        name: c.name || (c.is_im ? `dm:${c.user}` : c.id),
        kind: KIND(c),
        user: c.user, // only set for IMs
      });
    }
  }
  return out;
}

/** Directory of workspace members, so we can show names instead of U0123ABC. */
export async function listUsers(opts) {
  const out = [];
  for await (const page of paginate('users.list', { limit: 200 }, 'members', opts)) {
    for (const u of page) {
      if (u.deleted) continue;
      out.push({
        id: u.id,
        isBot: Boolean(u.is_bot),
        displayName: u.profile?.display_name || u.profile?.real_name || u.name,
        realName: u.profile?.real_name || u.name,
      });
    }
  }
  return out;
}

/**
 * Messages in a channel newer than `oldest`. Returns oldest-first.
 * `oldest` is exclusive on our side: we drop an exact-ts match so the cursor
 * message is never processed twice.
 */
export async function fetchHistory(channelId, { oldest, limit = 200, maxPages = 5 } = {}, opts) {
  const messages = [];
  let cursor;
  let pages = 0;

  do {
    const json = await call(
      'conversations.history',
      { channel: channelId, oldest, cursor, limit, inclusive: false },
      opts
    );
    messages.push(...(json.messages ?? []));
    cursor = json.has_more ? json.response_metadata?.next_cursor : undefined;
  } while (cursor && ++pages < maxPages);

  return messages
    .filter((m) => m.ts !== oldest)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** Replies in a thread, oldest-first, excluding the parent message. */
export async function fetchReplies(channelId, threadTs, { oldest } = {}, opts) {
  const json = await call(
    'conversations.replies',
    { channel: channelId, ts: threadTs, oldest, limit: 200, inclusive: false },
    opts
  );
  return (json.messages ?? [])
    .filter((m) => m.ts !== threadTs && m.ts !== oldest)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

/**
 * Permalink for a message. chat.getPermalink is the correct source of truth,
 * but we can synthesise one from the team domain if the call fails (e.g. a
 * scope gap) so a card is never left without a link back to Slack.
 */
export async function getPermalink(channelId, messageTs, { teamUrl } = {}, opts) {
  try {
    const json = await call('chat.getPermalink', { channel: channelId, message_ts: messageTs }, opts);
    return json.permalink;
  } catch {
    if (!teamUrl) return null;
    const p = messageTs.replace('.', '');
    return `${teamUrl.replace(/\/$/, '')}/archives/${channelId}/p${p}`;
  }
}

/**
 * Reply inside a thread. With a user token this posts as you, not as an app.
 * Requires the chat:write user scope - the only write Kent ever performs, and
 * only ever after the user presses Send.
 */
export async function postThreadReply(channelId, threadTs, text, opts) {
  const json = await call(
    'chat.postMessage',
    { channel: channelId, thread_ts: threadTs, text, unfurl_links: false, unfurl_media: false },
    opts
  );
  return { ts: json.ts, channel: json.channel };
}

/** A sample of my own recent messages, used to learn my writing style. */
export async function sampleMyMessages(myUserId, channelIds, limit = 30, opts) {
  const out = [];
  for (const channelId of channelIds) {
    if (out.length >= limit) break;
    try {
      const messages = await call('conversations.history', { channel: channelId, limit: 100 }, opts);
      for (const m of messages.messages ?? []) {
        if (m.user !== myUserId || !m.text) continue;
        const clean = m.text.replace(/<[^>]+>/g, '').trim();
        // Skip one-word acks and anything huge - neither says much about tone.
        if (clean.split(/\s+/).length < 3 || clean.length > 300) continue;
        out.push(clean);
        if (out.length >= limit) break;
      }
    } catch {
      // channel unreadable; try the next one
    }
  }
  return out;
}

/** Slack ts strings are unix seconds with microseconds: "1717171717.123456". */
export const tsToDate = (ts) => new Date(Number(ts) * 1000);
export const dateToTs = (date) => (date.getTime() / 1000).toFixed(6);
