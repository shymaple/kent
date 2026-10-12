/**
 * Asks that are already over by the time you read them.
 *
 * "can you join the meeting for 2 minutes?" passes every reasonable test for a
 * task — someone is asking you to attend something — and is still noise on a
 * board. The meeting ended while the card was being written. Acting on it isn't
 * work you schedule; it is a thing you either did or missed, in the moment.
 *
 * The model is told this in prompts/classify.md. This is the deterministic
 * backstop for when it says "task" anyway, and it is kept deliberately narrow:
 * the message must be short, must ask you to *be somewhere now*, and must carry
 * no deadline. "Join the design review on Thursday and present the numbers" is
 * real work and must survive — which it does, twice over, since it names a day.
 */

/** Beyond this, a message is carrying enough detail to be about real work. */
const MAX_LENGTH = 160;

/** The ask is happening now, or is measured in minutes. */
const IMMEDIACY =
  /\b(right now|now|rn|just now|quick|quickly|real quick|asap|currently|at the moment|already started|starting|started|waiting|we'?re on|in a (min|minute|sec|second)|for (a|an|\d+)\s*(min|mins|minute|minutes|sec|secs|second|seconds)\b|\d+\s*(min|mins|minute|minutes|sec|secs)\b)/i;

/**
 * Being asked to show up, rather than to produce anything.
 *
 * Only verbs of joining count. Bare "meeting" or "call" would swallow real work
 * like "meeting notes needed asap", which is exactly the kind of task this must
 * never eat.
 */
const JOIN =
  /\b(join|joining|hop (on|in)|jump (on|in)|dial in|get on|come (over|here|in|to)|drop by|huddle|hop over)\b/i;

/**
 * Is this an ask that expires within minutes?
 *
 * @param text        the raw message
 * @param hasDeadline whether a due date was found — a dated ask is never this
 */
export function looksEphemeral(text, { hasDeadline = false } = {}) {
  if (hasDeadline) return false;

  const body = String(text ?? '')
    .replace(/<[^>]*>/g, ' ')      // drop mentions and links; they aren't content
    .trim();

  if (!body || body.length > MAX_LENGTH) return false;
  return JOIN.test(body) && IMMEDIACY.test(body);
}
