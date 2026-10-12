/**
 * "I already dealt with this in Slack."
 *
 * Kent replays everything since its cursor when the laptop wakes up, which is
 * correct — nothing is ever lost — but a good chunk of that backlog is work you
 * read on your phone and answered hours ago. Re-triaging it is the worst kind of
 * noise: you have to remember, card by card, whether you already did the thing.
 *
 * Two signals settle it without asking, and both come from Slack itself:
 * a tick reaction you left, or a reply you posted in the thread afterwards.
 *
 * Deliberately NOT used: Slack's read cursor. Having read a message is not the
 * same as having handled it — that gap is the entire reason this tool exists.
 */

/** Reactions that mean "this is dealt with", not merely "seen". */
export const DEFAULT_HANDLED_REACTIONS = [
  'white_check_mark',
  'heavy_check_mark',
  'ballot_box_with_check',
  'done',
];

/** Stored as a JSON array of emoji names; falls back to the defaults. */
export function parseHandledReactions(raw) {
  try {
    const parsed = JSON.parse(raw ?? '');
    if (Array.isArray(parsed)) {
      const names = parsed
        .map((n) => String(n).trim().replace(/:/g, '').toLowerCase())
        .filter(Boolean);
      if (names.length) return names;
    }
  } catch {
    // fall through to the defaults
  }
  return DEFAULT_HANDLED_REACTIONS;
}

/** The name of the "done" reaction I put on this message, or null. */
export function myHandledReaction(message, myUserId, names = DEFAULT_HANDLED_REACTIONS) {
  if (!myUserId || !Array.isArray(message?.reactions)) return null;
  const wanted = new Set(names);
  for (const r of message.reactions) {
    // Skin-tone variants arrive as "thumbsup::skin-tone-3".
    const name = String(r?.name ?? '').split('::')[0].toLowerCase();
    if (wanted.has(name) && Array.isArray(r.users) && r.users.includes(myUserId)) return name;
  }
  return null;
}

/**
 * A reply of mine, posted in this message's thread after it landed.
 *
 * `reply_users` comes free on a parent message in conversations.history, so the
 * common case — someone asks in-channel, I answer in the thread — costs no extra
 * API call. It is capped by Slack at a handful of distinct repliers, so the scan
 * over messages we already fetched backs it up (and is the only thing that works
 * when the candidate is itself a reply inside a thread).
 */
export function myReplyAfter(message, myUserId, messages = []) {
  if (!myUserId || !message) return null;

  if (Array.isArray(message.reply_users) && message.reply_users.includes(myUserId)) {
    return message.latest_reply ?? message.ts;
  }

  const thread = message.thread_ts ?? message.ts;
  for (const m of messages) {
    if (m.user !== myUserId || m.ts === message.ts) continue;
    if ((m.thread_ts ?? m.ts) !== thread) continue;
    if (Number(m.ts) > Number(message.ts)) return m.ts;
  }
  return null;
}

/**
 * Has this message already been handled by me, in Slack?
 *
 * @param message   raw Slack message
 * @param ctx       { myUserId, reactions:string[], messages:[] already fetched }
 * @returns null, or { kind: 'reaction' | 'reply', detail }
 */
export function handledInSlack(message, { myUserId, reactions, messages = [] } = {}) {
  const reaction = myHandledReaction(message, myUserId, reactions);
  if (reaction) return { kind: 'reaction', detail: `:${reaction}:` };

  const ts = myReplyAfter(message, myUserId, messages);
  if (ts) return { kind: 'reply', detail: ts };

  return null;
}

/** How the Inbox and the sync log explain a retirement. */
export const handledLabel = (signal) =>
  signal?.kind === 'reaction'
    ? `you reacted ${signal.detail} in Slack`
    : 'you already replied in the Slack thread';
