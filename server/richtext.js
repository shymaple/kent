/**
 * Rich-text descriptions, kept safe.
 *
 * A description used to be one plain string, which is fine for "Blocking the
 * release" and useless for what people actually paste into a task: a short list
 * of steps, a bolded caveat, a link. The editor in the client produces HTML, and
 * HTML that is stored and later written into the page is the classic way a local
 * tool grows a script-injection hole - a description can also start life as text
 * the model derived from someone else's Slack message.
 *
 * So nothing the client sends is stored as it arrived. The markup is rebuilt
 * here from a short allowlist: a tag is either re-emitted in a canonical form
 * with no attributes at all, or dropped and its text kept. The one attribute
 * that survives is an anchor's href, and only as an http(s) or mailto URL. An
 * event handler, a style, a javascript: link or a tag nobody listed has no way
 * through, because the output never contains anything copied from inside a tag.
 *
 * The plain-text rendering is stored alongside, so search, the card, the reply
 * drafter and link extraction keep working on text and never parse HTML.
 */

const ALLOWED = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'code', 'blockquote',
  'p', 'div', 'br', 'ul', 'ol', 'li', 'a',
]);
const VOID = new Set(['br']);

/** Longest description stored, counted in characters of markup. */
const MAX_HTML = 20_000;

const escapeText = (text) => text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (text) =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decodeEntities = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16) || 0xfffd);
    if (key.startsWith('#')) return String.fromCodePoint(Number(key.slice(1)) || 0xfffd);
    return whole;
  });

/** An href worth keeping, normalised, or null. */
function safeHref(raw) {
  const value = decodeEntities(String(raw ?? '')).trim();
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Rebuild editor HTML from the allowlist.
 *
 * @returns sanitised markup, or null when there is no visible content left
 */
export function sanitizeHtml(input) {
  const source = String(input ?? '').slice(0, MAX_HTML)
    // Whole elements whose *content* is not content either.
    .replace(/<(script|style|iframe|object|embed|template|noscript)\b[\s\S]*?(<\/\1\s*>|$)/gi, '')
    .replace(/<!--[\s\S]*?(-->|$)/g, '');

  let out = '';
  let openAnchors = 0;

  for (const token of source.split(/(<[^>]*>)/)) {
    if (!token) continue;

    const tag = /^<\s*(\/?)\s*([a-z][a-z0-9]*)\b([^>]*)>$/i.exec(token);
    if (!tag) {
      // Text, or a "<" that never became a tag. Either way it is shown, not run.
      out += escapeText(token);
      continue;
    }

    const [, closing, rawName, rest] = tag;
    const name = rawName.toLowerCase();
    if (!ALLOWED.has(name)) continue;                 // drop the tag, keep its text

    if (name === 'a') {
      if (closing) {
        if (openAnchors > 0) {
          openAnchors--;
          out += '</a>';
        }
        continue;
      }
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(rest);
      const url = safeHref(href?.[1] ?? href?.[2] ?? href?.[3]);
      if (!url) continue;                             // an unsafe link becomes plain text
      openAnchors++;
      out += `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer noopener">`;
      continue;
    }

    if (VOID.has(name)) out += `<${name}>`;
    else out += closing ? `</${name}>` : `<${name}>`;
  }

  out += '</a>'.repeat(openAnchors);
  return htmlToText(out) ? out : null;
}

/** The text a reader sees, with list items and paragraphs on their own lines. */
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<li>/gi, '\n- ')
      .replace(/<br>|<\/(p|div|ul|ol|blockquote)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Every link target in sanitised markup, with the text it was given. */
export function linksInHtml(html) {
  const found = [];
  for (const m of String(html ?? '').matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = decodeEntities(m[1]);
    const label = htmlToText(m[2]);
    found.push({ url, label: label && label !== url ? label.slice(0, 80) : null });
  }
  return found;
}
