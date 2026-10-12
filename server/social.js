/**
 * Asks that are addressed to you and are still not work.
 *
 * "@you how are you?" and "@you are you coming for lunch?" clear every
 * structural bar Kent has: a direct mention, a question, sometimes even a time.
 * They were turning into cards, and a board that holds lunch plans next to a
 * production bug stops being a list of work — which is the only thing it is for.
 *
 * The model is told this in prompts/classify.md. This is the deterministic
 * backstop for when it says "task" anyway, in the same spirit as ephemeral.js,
 * and it is kept just as narrow. Two shapes only:
 *
 *   1. the whole message is a greeting, a check-in, thanks or congratulations;
 *   2. a short question about joining a meal, a break or an outing.
 *
 * Anything carrying a link, a file or a word of real work survives untouched:
 * "can you book the venue for the team dinner" and "present the roadmap at the
 * lunch-and-learn" are jobs that happen to mention food. Unlike an ephemeral
 * ask, a date does not rescue these — dinner on Friday is still dinner.
 */

/** Beyond this, a message is carrying enough detail to be about real work. */
const MAX_LENGTH = 140;

const HELLO = String.raw`(?:(?:hi|hey|hello|hiya|yo|namaste)\b[\s,!.]*)?`;

/** The entire message, once mentions are stripped, is social. */
const ONLY_SOCIAL = new RegExp(
  `^${HELLO}(?:` +
    [
      String.raw`(?:hi|hey|hello|hiya|yo|namaste)`,
      String.raw`good (?:morning|afternoon|evening|night)(?: (?:all|team|everyone))?`,
      String.raw`how(?:'s| is| are| r) (?:you|u|it going|things|life|everything)(?: doing| today| these days)?`,
      String.raw`how have you been`,
      String.raw`how was (?:your |the )?(?:weekend|trip|vacation|holiday|leave|day|evening|diwali|break)`,
      String.raw`what'?s up|wass?up|sup`,
      String.raw`hope (?:you'?re|you are|all is) (?:doing )?(?:well|good|ok|okay|fine)`,
      String.raw`(?:thanks|thank you|thx|ty)(?: (?:a lot|so much|a ton))?`,
      String.raw`(?:many )?(?:congrats|congratulations)(?: on [^?]*)?`,
      String.raw`happy (?:birthday|bday|anniversary|new year|diwali|holi|eid|christmas|friday|weekend|holidays)(?: [^?]*)?`,
      String.raw`(?:get well soon|take care|welcome back|safe travels)`,
    ].join('|') +
    String.raw`)[\s,!.?]*(?:and\s+)?` +
    String.raw`(?:how(?:'s| is| are| was) [^?]{0,40})?[\s!.?]*$`,
  'i'
);

/** Food, breaks and outings — the subject of a social plan. */
const SOCIAL_SUBJECT =
  /\b(lunch|dinner|breakfast|brunch|coffee|chai|tea|snacks?|drinks?|beers?|party|outing|picnic|movie|cricket|football|potluck|cake|smoke|walk)\b/i;

/** Being asked whether you are coming along, rather than to produce anything. */
const INVITE =
  /\b(coming|come|join|joining|up for|free for|want|wanna|fancy|care for|shall we|let'?s|going|grab|in for|keen)\b|^\W*\w+(?:\s+\w+){0,3}\s*\?\s*$/i;

/**
 * Words that mean someone is relying on you to deliver something. One of these
 * anywhere in the message and it is left to the model's verdict.
 */
const WORK =
  /\b(book|order|arrange|organi[sz]e|plan|host|present|presentation|prepare|review|report|deck|doc|document|sheet|slides?|deploy|release|fix|bug|ticket|issue|client|customer|vendor|invoice|budget|expenses?|reimburse\w*|approve|approval|sign|send|share|update|draft|write|submit|fill|form|agenda|numbers|headcount|data|spec|contract|proposal|deadline|eod|asap|urgent|learn)\b/i;

/**
 * Is this a greeting or a social plan rather than work?
 *
 * @param text      the raw message
 * @param hasLinks  whether the message carries a link or a file
 */
export function looksSocial(text, { hasLinks = false } = {}) {
  if (hasLinks) return false;

  const body = String(text ?? '')
    .replace(/<[^>]*>/g, ' ')              // mentions and links aren't content
    .replace(/:[a-z0-9_+-]+:/gi, ' ')      // nor are emoji shortcodes
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!body || body.length > MAX_LENGTH) return false;
  if (WORK.test(body)) return false;
  if (ONLY_SOCIAL.test(body)) return true;
  return SOCIAL_SUBJECT.test(body) && INVITE.test(body);
}
