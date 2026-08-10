/**
 * Deterministic deadline extraction.
 *
 * The model misses deadlines that are grammatically buried — "before the review
 * on Thursday" reads as a noun phrase rather than a due date, so it returned
 * null. A weekday name is a rule, not a judgement call, so it belongs in code.
 *
 * Used as a fallback: a date the model found is kept as-is, and this only fills
 * the gap when it returned nothing.
 *
 * All arithmetic happens on a "civil date" — the YYYY-MM-DD the sender saw in
 * their own timezone, anchored at UTC midnight — so day maths can never drift
 * across a timezone boundary.
 */

/**
 * Full weekday names are safe to match anywhere in a sentence.
 * Abbreviations are not — "I sat down", "we wed last year", "mon dieu" would all
 * become deadlines — so those require a cue word in front (see CUE below).
 */
const WEEKDAYS_FULL = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const WEEKDAYS_SHORT = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3,
  thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};

const CUE = '(?:by|before|on|due|until|till|this|next|coming|coz|eod)';

const MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10,
  december: 11, dec: 11,
};

const DAY_MS = 86_400_000;

/** The date the sender saw, as YYYY-MM-DD in their timezone. */
function civilDate(date, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

const toAnchor = (ymd) => Date.parse(`${ymd}T00:00:00Z`);
const toYmd = (anchor) => new Date(anchor).toISOString().slice(0, 10);
const weekdayOf = (anchor) => new Date(anchor).getUTCDay();

/**
 * The next occurrence of `weekday` on or after `anchor`.
 * Saying "by Friday" on a Friday means today, not a week away.
 */
function nextWeekday(anchor, weekday) {
  const delta = (weekday - weekdayOf(anchor) + 7) % 7;
  return anchor + delta * DAY_MS;
}

/** Strip Slack markup and code so a URL or snippet can't look like a date. */
function clean(text = '') {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .toLowerCase();
}

/**
 * Find a deadline in a message.
 *
 * @param text     raw message text
 * @param sentAt   Date the message was sent
 * @param timezone IANA zone the dates should be read in
 * @returns 'YYYY-MM-DD' or null
 */
export function parseDeadline(text, sentAt, timezone = 'UTC') {
  if (!text || !(sentAt instanceof Date) || Number.isNaN(sentAt.getTime())) return null;

  const t = clean(text);
  const today = toAnchor(civilDate(sentAt, timezone));
  if (Number.isNaN(today)) return null;

  const within = (anchor) => {
    // Reject anything in the past or absurdly far out - both are misreads.
    if (anchor < today || anchor > today + 400 * DAY_MS) return null;
    return toYmd(anchor);
  };

  // --- explicit calendar dates -------------------------------------------
  // 2026-08-28
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return within(toAnchor(`${iso[1]}-${iso[2]}-${iso[3]}`));

  // "28 August", "28th Aug", "August 28", "Aug 28th" - year inferred forward
  const monthNames = Object.keys(MONTHS).join('|');
  const dayFirst = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})\\b`));
  const monthFirst = t.match(new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  const explicit = dayFirst
    ? { day: Number(dayFirst[1]), month: MONTHS[dayFirst[2]] }
    : monthFirst
      ? { day: Number(monthFirst[2]), month: MONTHS[monthFirst[1]] }
      : null;

  if (explicit && explicit.day >= 1 && explicit.day <= 31) {
    const year = new Date(today).getUTCFullYear();
    for (const y of [year, year + 1]) {
      const candidate = Date.UTC(y, explicit.month, explicit.day);
      // Guard against a rolled-over day like 31 February.
      if (new Date(candidate).getUTCMonth() !== explicit.month) break;
      if (candidate >= today) return within(candidate);
    }
    return null;
  }

  // --- relative wording ---------------------------------------------------
  if (/\bday after tomorrow\b/.test(t)) return within(today + 2 * DAY_MS);
  if (/\btomorrow\b/.test(t)) return within(today + DAY_MS);
  if (/\b(today|tonight|end of (the )?day|eod|by cob|cob)\b/.test(t)) return within(today);

  if (/\bend of (the )?month\b|\beom\b/.test(t)) {
    const d = new Date(today);
    return within(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  }
  if (/\bend of (the )?week\b|\beow\b/.test(t)) return within(nextWeekday(today, 5));

  // "in 3 days", "in 2 weeks"
  const inN = t.match(/\bin\s+(\d{1,2})\s+(day|week)s?\b/);
  if (inN) {
    const n = Number(inN[1]);
    return within(today + n * (inN[2] === 'week' ? 7 : 1) * DAY_MS);
  }

  // --- weekday names ------------------------------------------------------
  // Full names match anywhere, not only after "by"/"on": the miss that prompted
  // all of this was "before the review on Thursday", where the day name sits
  // inside a noun phrase rather than after a deadline preposition.
  const full = t.match(
    new RegExp(`\\b(next\\s+|this\\s+)?(${Object.keys(WEEKDAYS_FULL).join('|')})\\b`)
  );
  if (full) {
    const target = nextWeekday(today, WEEKDAYS_FULL[full[2]]);
    // "next Thursday" means the Thursday of the following week.
    return within(full[1]?.trim() === 'next' ? target + 7 * DAY_MS : target);
  }

  // Abbreviations only count behind a cue word, so ordinary prose is safe.
  const short = t.match(
    new RegExp(`\\b${CUE}\\s+(${Object.keys(WEEKDAYS_SHORT).join('|')})\\b`)
  );
  if (short) {
    const isNext = new RegExp(`\\bnext\\s+${short[1]}\\b`).test(t);
    const target = nextWeekday(today, WEEKDAYS_SHORT[short[1]]);
    return within(isNext ? target + 7 * DAY_MS : target);
  }

  // "next week" -> the Monday that starts it, i.e. the first Monday after today.
  if (/\bnext week\b/.test(t)) return within(nextWeekday(today + DAY_MS, 1));

  return null;
}
