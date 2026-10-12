/**
 * Deterministic candidate detection. Pure functions, no I/O, no LLM.
 *
 * This is the cost control: only messages that survive here are ever shown to
 * the model. Everything else is discarded for free.
 */

const BROADCAST_RE = /<!(channel|here|everyone)>/;

/** Escape a user-supplied alias for safe use inside a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build one case-insensitive regex matching any alias on a word boundary.
 * `\b` doesn't work for aliases starting with "@", so we anchor on a
 * non-word character or string edge instead.
 */
export function buildAliasMatcher(aliases) {
  const cleaned = (aliases ?? []).map((a) => String(a).trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  const alt = cleaned.map(escapeRe).join('|');
  return new RegExp(`(?:^|[^\\w])(?:${alt})(?:$|[^\\w])`, 'i');
}

/** Strip Slack markup so alias matching isn't fooled by links or code blocks. */
export function plainText(text = '') {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<(https?:[^|>]+)\|([^>]*)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, ' ')
    .replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, ' ')
    .replace(/<#(C[A-Z0-9]+)(\|[^>]*)?>/g, ' ');
}

/**
 * Decide whether a Slack message is a candidate task for `me`.
 *
 * @param message  raw Slack message object
 * @param ctx      { myUserId, channelKind, aliasMatcher, myThreadTs:Set<string> }
 * @returns {null | { reason, isBroadcast }}
 */
export function classifyCandidate(message, ctx) {
  const { myUserId, channelKind, aliasMatcher, myThreadTs, priorityUserIds } = ctx;

  // Structural skips - never worth a look.
  if (!message || message.subtype === 'channel_join' || message.subtype === 'channel_leave') return null;
  if (message.subtype === 'message_deleted' || message.subtype === 'tombstone') return null;
  if (!message.text || !message.text.trim()) return null;

  const text = message.text;
  const mentionsMe = Boolean(myUserId) && text.includes(`<@${myUserId}>`);

  // Bots only matter when they address me outright - "<@you> was assigned FOO"
  // from Jira or Asana is a real task. Status echoes that merely repeat my name
  // ("Alex is currently working on...") are noise and must not cost a call.
  // Note some bots post with a user id too, so bot_id alone is the tell.
  if ((message.bot_id || message.subtype === 'bot_message') && !mentionsMe) return null;

  // My own messages are skipped, unless I deliberately @mentioned myself -
  // that is a note-to-self, and an intentional signal worth capturing.
  if (message.user === myUserId && !mentionsMe) return null;

  // 1. Direct @mention of me (including one I wrote myself).
  //
  // Note there is deliberately no "everything in a DM counts" rule. DMs are
  // ordinary conversation as much as channels are, and treating every line as a
  // task both buried the real work and sent the model a pile of chatter. A DM
  // has to earn a card the same way a channel message does - it just keeps its
  // own label so the Inbox can still show where it came from.
  if (mentionsMe) {
    const isDm = channelKind === 'im' || channelKind === 'mpim';
    const reason = message.user === myUserId
      ? 'self'
      : isDm
        ? (channelKind === 'im' ? 'dm' : 'group_dm')
        : 'mention';
    return { reason, isBroadcast: false };
  }

  // 2. Anything from someone on the priority list.
  //
  // People who matter often just say "can you take a look at this" without
  // tagging anyone - in a DM or a small channel the mention is redundant to
  // them, but it is the only signal we had. The list is small and hand-picked,
  // so reading everything they write is cheap, and the model still decides
  // whether it is actually a task.
  if (priorityUserIds?.size && message.user && priorityUserIds.has(message.user)) {
    return { reason: 'priority_person', isBroadcast: false };
  }

  // 3. Reply inside a thread I participate in.
  if (message.thread_ts && message.thread_ts !== message.ts && myThreadTs?.has(message.thread_ts)) {
    return { reason: 'thread_reply', isBroadcast: false };
  }

  // 4. Channel-wide broadcast - low value, goes to Miscellaneous.
  if (BROADCAST_RE.test(text)) {
    return { reason: 'broadcast', isBroadcast: true };
  }

  // 5. My name typed out without an @mention.
  if (aliasMatcher && aliasMatcher.test(plainText(text))) {
    return { reason: 'alias', isBroadcast: false };
  }

  return null;
}

const LINK_LABELS = [
  [/docs\.google\.com\/document/i, 'Google Doc'],
  [/docs\.google\.com\/spreadsheets/i, 'Google Sheet'],
  [/docs\.google\.com\/presentation/i, 'Google Slides'],
  [/drive\.google\.com/i, 'Google Drive'],
  [/figma\.com/i, 'Figma'],
  [/notion\.so/i, 'Notion'],
  [/atlassian\.net\/browse/i, 'Jira'],
  [/atlassian\.net\/wiki/i, 'Confluence'],
  [/linear\.app/i, 'Linear'],
  [/github\.com\/[^/]+\/[^/]+\/pull/i, 'GitHub PR'],
  [/github\.com\/[^/]+\/[^/]+\/issues/i, 'GitHub Issue'],
  [/github\.com/i, 'GitHub'],
  [/loom\.com/i, 'Loom'],
  [/zoom\.us/i, 'Zoom'],
  [/miro\.com/i, 'Miro'],
  [/slack\.com\/archives/i, 'Slack message'],
];

/**
 * Pull URLs out of a message: the text itself, any uploaded files, and any
 * attachment blocks. Deterministic - the model never invents or fetches links.
 *
 * For uploaded files we store Slack's `permalink` (the Slack-hosted page) and
 * deliberately never `url_private`: the card should link back into Slack, not
 * hand out a direct handle on the document.
 *
 * @param message a Slack message object, or a plain string for text-only use
 */
export function extractLinks(message = '') {
  const msg = typeof message === 'string' ? { text: message } : (message ?? {});
  const text = msg.text ?? '';
  const found = new Map();

  const add = (url, label, kind) => {
    if (typeof url !== 'string') return;
    const clean = url.replace(/[).,;]+$/, '');
    if (!/^https?:\/\//i.test(clean) || found.has(clean)) return;
    const known = LINK_LABELS.find(([re]) => re.test(clean));
    found.set(clean, { url: clean, label: label || (known ? known[1] : 'Link'), ...(kind ? { kind } : {}) });
  };

  // <url|label> and <url>
  for (const m of text.matchAll(/<(https?:[^|>]+)(?:\|([^>]*))?>/g)) add(m[1], m[2]?.trim() || null);

  // bare urls, ignoring the angle-bracket forms already handled
  const stripped = text.replace(/<https?:[^>]+>/g, ' ');
  for (const m of stripped.matchAll(/https?:\/\/[^\s<>|]+/g)) add(m[0], null);

  // Uploaded files - Slack permalink only.
  for (const f of msg.files ?? []) {
    if (!f?.permalink) continue;
    const kind = (f.filetype || f.pretty_type || 'file').toUpperCase();
    add(f.permalink, f.name ? `${kind} · ${f.name}` : `${kind} file`, 'file');
  }

  // Link previews and app attachments.
  for (const a of msg.attachments ?? []) {
    add(a?.title_link, a?.title?.trim() || null);
    add(a?.from_url, a?.title?.trim() || null);
  }

  return [...found.values()];
}

/**
 * Is this stored link a file someone uploaded, rather than a URL they wrote?
 *
 * New rows say so with `kind`. Rows saved before that was recorded are told
 * apart by what a Slack file permalink looks like.
 */
export const isAttachment = (link) =>
  link?.kind === 'file' || /^https:\/\/[^/]+\.slack\.com\/files\//i.test(link?.url ?? '');
