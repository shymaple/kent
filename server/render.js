/**
 * Turn Slack's wire format into something a human wants to read.
 *
 * Slack sends mentions as `<@U01ABC23DEF>`, channels as `<#C123|general>` and
 * links as `<url|label>`. Showing that raw on a card is unreadable, so every
 * user-facing string goes through here on the way out. The raw text stays in the
 * database untouched - this is a display concern only.
 */
import { db } from './db.js';

let cache = null;
let cachedAt = 0;
const TTL_MS = 60_000;

function directory() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;

  const users = new Map(
    db.prepare('SELECT slack_user_id, display_name FROM people').all()
      .map((p) => [p.slack_user_id, p.display_name])
  );
  const channels = new Map(
    db.prepare('SELECT id, name FROM channels').all().map((c) => [c.id, c.name])
  );

  cache = { users, channels };
  cachedAt = Date.now();
  return cache;
}

/** Called after a directory refresh so new names show up immediately. */
export function invalidateDirectory() {
  cache = null;
}

/** "alex.chen" -> "Alex Chen" */
export function humaniseHandle(handle) {
  return String(handle)
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Replace Slack markup with readable text.
 * Unknown user ids fall back to a neutral "@someone" rather than leaking a raw id.
 */
export function renderSlackText(text) {
  if (!text) return text ?? '';
  const { users, channels } = directory();

  return String(text)
    // <@U123|label> and <@U123>
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => {
      if (label) return `@${label}`;
      const name = users.get(id);
      return name ? `@${name}` : '@someone';
    })
    // <#C123|name> and <#C123>
    .replace(/<#([CGD][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => {
      const name = label || channels.get(id);
      return name ? `#${name}` : '#channel';
    })
    // <!subteam^S123|@team> and <!channel> / <!here> / <!everyone>
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label) => label || '@team')
    .replace(/<!(channel|here|everyone)(?:\|[^>]*)?>/g, (_, kind) => `@${kind}`)
    // <url|label> and <url>
    .replace(/<(https?:[^|>]+)\|([^>]*)>/g, (_, url, label) => label || url)
    .replace(/<(https?:[^>]+)>/g, '$1')
    // Slack escapes these three, and only these three
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Readable name for a conversation.
 *
 * Group DMs arrive as "mpdm-alex.chen--jordan.blake--sam.rivera-1",
 * which is unusable in a picker. Turn it into the other people's names, dropping
 * yourself since you are in every one of them.
 */
export function renderConversationName(channel, myHandle) {
  const name = typeof channel === 'string' ? channel : channel?.name;
  if (!name) return channel?.id ?? '';

  // Keyed off the name pattern rather than `kind`, so this also works for the
  // channel_name copied onto a task, where the kind isn't carried along.
  if (/^mpdm-/.test(name)) {
    const handles = name
      .replace(/^mpdm-/, '')
      .replace(/-\d+$/, '')
      .split('--')
      .filter((h) => h && h !== myHandle);

    if (handles.length === 0) return 'Group DM';
    const names = handles.map(humaniseHandle);
    if (names.length <= 3) return names.join(', ');
    return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
  }

  return name;
}
