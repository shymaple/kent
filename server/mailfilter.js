/**
 * Deterministic candidate detection for email. Pure functions, no I/O, no LLM.
 *
 * An inbox is mostly not asks. Newsletters, receipts, calendar machinery, build
 * notifications and every thread you were cc'd on "for visibility" outnumber the
 * mail that wants something from you many times over, and showing all of it to
 * the model would spend a call per sync on mail nobody would ever call a task.
 * This is the same cost control prefilter.js is for Slack: only what survives
 * here is ever read by the model.
 *
 * The bar mirrors the Slack one. Being addressed directly (in To) is the
 * equivalent of an @mention. Being cc'd is the equivalent of being in the
 * channel - it only counts when the message names you.
 */

/** Gmail's own triage. Mail it filed here is not from a person asking you for something. */
const SKIP_LABELS = new Set([
  'SENT', 'DRAFT', 'SPAM', 'TRASH', 'CHAT',
  'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS',
]);

/** Senders that are a system, not a colleague. */
const ROBOT_SENDER =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?|news|newsletter|digest|marketing|receipts?|calendar-notification)[^@]*@/i;

/** Addressed to this many people, it is an announcement rather than a request to you. */
const MANY_RECIPIENTS = 8;

/**
 * Decide whether an email is a candidate task for `me`.
 *
 * @param mail  a message as shaped by gmail.js `parseMessage`
 * @param ctx   { myAddress, aliasMatcher }
 * @returns {null | { reason, isBroadcast }}
 */
export function classifyMail(mail, ctx) {
  const myAddress = String(ctx?.myAddress ?? '').toLowerCase();
  if (!mail || !myAddress) return null;

  if (mail.labelIds?.some((l) => SKIP_LABELS.has(l))) return null;
  if (mail.from?.email === myAddress) return null;          // my own mail, or a note to self
  if (!mail.body?.trim() && !mail.subject?.trim()) return null;

  // Bulk and automated mail. Any one of these is enough: a human writing to you
  // sets none of them.
  if (mail.listUnsubscribe || mail.listId) return null;
  if (['bulk', 'list', 'junk'].includes(mail.precedence)) return null;
  if (mail.autoSubmitted && mail.autoSubmitted !== 'no') return null;
  if (ROBOT_SENDER.test(mail.from?.email ?? '')) return null;
  // Invitations are answered in the calendar, and the calendar already nags.
  if (mail.hasCalendar) return null;

  if (mail.to?.includes(myAddress)) {
    const recipients = new Set([...(mail.to ?? []), ...(mail.cc ?? [])]).size;
    return { reason: 'email_to', isBroadcast: recipients >= MANY_RECIPIENTS };
  }

  // Cc'd, bcc'd or reached through a group alias: only when it names you.
  if (ctx.aliasMatcher?.test(`${mail.subject}\n${mail.body}`)) {
    return { reason: 'email_cc', isBroadcast: false };
  }

  return null;
}
