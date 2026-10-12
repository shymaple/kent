/**
 * Recognising a link to one Slack message.
 *
 * "Make a task from this" starts with a URL pasted by hand, and a pasted URL is
 * whatever was on the clipboard: a link to a channel rather than a message, a
 * file, a Google Doc, a link from a different workspace than the one Kent is
 * connected to, or a perfectly good message link with tracking junk appended.
 * Each of those used to be a candidate for "ask Slack and see" - which turns a
 * typo into a confusing API error, and sends whatever was pasted to the network.
 *
 * So the shape is checked here first, with no I/O, and the answer names what is
 * wrong. Only a link that is unmistakably one message in the connected workspace
 * goes any further.
 *
 *   https://acme.slack.com/archives/C0123ABCD/p1720000000000200
 *   https://acme.slack.com/archives/C0123ABCD/p1720000000000300?thread_ts=1720000000.000200&cid=C0123ABCD
 */

const CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;
const MESSAGE_PART = /^p(\d{16})$/;
const TS = /^\d{10}\.\d{6}$/;

const REASONS = {
  not_url: 'That is not a link. Paste the link Slack gives you from a message’s ⋮ menu → Copy link.',
  not_slack: 'That is not a Slack link. It should start with https://your-workspace.slack.com/archives/…',
  not_message:
    'That Slack link does not point at a single message. In Slack, hover the message → ⋮ → Copy link.',
  other_workspace: 'That message is in a different Slack workspace from the one Kent is connected to.',
};

const fail = (code) => ({ ok: false, code, error: REASONS[code] });

/**
 * @param input       whatever was pasted
 * @param teamDomain  the connected workspace's URL, when known - "https://acme.slack.com/"
 * @returns { ok: true, channelId, ts, threadTs, url } | { ok: false, code, error }
 */
export function parseSlackLink(input, { teamDomain } = {}) {
  const text = String(input ?? '').trim().replace(/^<|>$/g, '');
  if (!text) return fail('not_url');

  let url;
  try {
    url = new URL(text);
  } catch {
    return fail('not_url');
  }

  // Exact suffix on the hostname: "slack.com.evil.example" and
  // "notslack.com" are not Slack, whatever their path looks like.
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !host.endsWith('.slack.com') || url.username || url.password) {
    return fail('not_slack');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const message = MESSAGE_PART.exec(parts[2] ?? '');
  if (parts.length !== 3 || parts[0] !== 'archives' || !CHANNEL_ID.test(parts[1]) || !message) {
    return fail('not_message');
  }

  if (teamDomain) {
    try {
      if (new URL(teamDomain).hostname.toLowerCase() !== host) return fail('other_workspace');
    } catch {
      // An unreadable stored domain is not the user's mistake; let Slack decide.
    }
  }

  const digits = message[1];
  const ts = `${digits.slice(0, 10)}.${digits.slice(10)}`;
  const threadParam = url.searchParams.get('thread_ts');
  const threadTs = threadParam && TS.test(threadParam) && threadParam !== ts ? threadParam : null;

  return {
    ok: true,
    channelId: parts[1],
    ts,
    threadTs,
    // Rebuilt from the parts that were checked, so nothing else pasted along
    // with the link is ever stored or shown as a link.
    url: `https://${host}/archives/${parts[1]}/p${digits}${threadTs ? `?thread_ts=${threadTs}&cid=${parts[1]}` : ''}`,
  };
}
