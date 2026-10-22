// Format inference from a field's sample value (plan.md §5.1 step 4) — code.
// Dates: the printed pattern ("11/2025" → MM/YYYY). A day/month order is only
// decided when a number > 12 shows which is the day; otherwise it is flagged
// ambiguous for the user (never guessed). Letter case: an all-capitals sample
// (SUPPLEMENT) → upper, an all-lower-case one → lower.

const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$/i;

/** → { date: pattern } | { date: null, ambiguous: [patterns] } | null (not a date). */
export function inferDateFormat(sample) {
  const s = String(sample ?? "").trim();
  let m;
  if ((m = s.match(/^(\d{1,2})([/.\-])(\d{4})$/))) return Number(m[1]) >= 1 && Number(m[1]) <= 12 ? { date: `MM${m[2]}YYYY` } : null;
  if ((m = s.match(/^(\d{1,2})([/.\-])(\d{2})$/))) return Number(m[1]) >= 1 && Number(m[1]) <= 12 ? { date: `MM${m[2]}YY` } : null;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return { date: "YYYY-MM-DD" };
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) return { date: "YYYY-MM" };
  if ((m = s.match(/^(\d{1,2})([/.\-])(\d{1,2})\2(\d{4}|\d{2})$/))) {
    const [a, b] = [Number(m[1]), Number(m[3])];
    const sep = m[2];
    const y = m[4].length === 4 ? "YYYY" : "YY";
    if (a < 1 || b < 1 || a > 31 || b > 31 || (a > 12 && b > 12)) return null;
    if (a > 12) return { date: `DD${sep}MM${sep}${y}` };
    if (b > 12) return { date: `MM${sep}DD${sep}${y}` };
    return { date: null, ambiguous: [`DD${sep}MM${sep}${y}`, `MM${sep}DD${sep}${y}`] };
  }
  if ((m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,9}\.?)[\s\-,]+(\d{4})$/)) && MONTHS.test(m[2])) return { date: `DD${s.includes("-") ? "-" : " "}MMM${s.includes("-") ? "-" : " "}YYYY` };
  if ((m = s.match(/^([A-Za-z]{3,9}\.?)[\s\-]+(\d{4})$/)) && MONTHS.test(m[1])) return { date: `MMM${s.includes("-") ? "-" : " "}YYYY` };
  return null;
}

/** → "upper" | "lower" | null from the letters of a sample. Codes with digits
 *  (AVVS1122005, ADD-E120) are printed as they come — no case is forced. */
export function inferCase(sample) {
  if (/\d/.test(String(sample ?? ""))) return null;
  const letters = String(sample ?? "").replace(/[^\p{L}]/gu, "");
  if (letters.length < 2) return null;
  if (letters === letters.toLocaleUpperCase("en-US") && letters !== letters.toLocaleLowerCase("en-US")) return "upper";
  if (letters === letters.toLocaleLowerCase("en-US") && letters !== letters.toLocaleUpperCase("en-US")) return "lower";
  return null;
}

/**
 * The format for a source of `type` printed as `sample`.
 * → { format: {...} | null, ambiguousDate?: [patterns] }
 */
export function inferFormat(sample, type) {
  const format = {};
  let ambiguousDate;
  if (type === "date") {
    const d = inferDateFormat(sample);
    if (d?.date) format.date = d.date;
    else if (d?.ambiguous) ambiguousDate = d.ambiguous;
  } else {
    const c = inferCase(sample);
    if (c) format.case = c;
  }
  return { format: Object.keys(format).length ? format : null, ...(ambiguousDate ? { ambiguousDate } : {}) };
}

/** Whether a sample can be a value of `type` (dictionary plausibility, §5.2 step 2). */
export function plausibleForType(sample, type) {
  const s = String(sample ?? "").trim();
  if (!s) return false;
  if (type === "date") return inferDateFormat(s) !== null || /^\d{4}-\d{2}(-\d{2})?$/.test(s);
  if (type === "number") return /^-?[\d.,\s]+$/.test(s);
  return true;
}
