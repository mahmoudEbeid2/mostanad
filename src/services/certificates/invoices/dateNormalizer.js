// Deterministic invoice-date normalisation (CERTIFICATES_V2_PLAN.md §9.1):
// every date keeps its raw string, and gets an ISO form ONLY when the raw
// text is unambiguous. "03/04/2025" could be 3 April or 4 March → no ISO
// (the reviewer fixes it); "15/04/2025", "04/2025", "Apr 2025" are fine.
// Month-precision dates normalise to "YYYY-MM" — a day is never invented.

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const pad = (n) => String(n).padStart(2, "0");
const validDay = (y, m, d) => d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
/** "Apr" / "april" / "Sept" → 4 / 4 / 9; anything that isn't a month (prefix ≥ 3 letters) → null */
const monthOf = (s) => {
  const k = String(s).toLowerCase();
  const i = k.length >= 3 ? MONTH_NAMES.findIndex((n) => n.startsWith(k)) : -1;
  return i >= 0 ? i + 1 : null;
};

/** → "YYYY-MM-DD" | "YYYY-MM" | null */
export function normalizeDate(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m;
  // ISO: 2025-04-15 / 2025-04
  if ((m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null];
    if (mo < 1 || mo > 12) return null;
    if (d === null) return `${y}-${pad(mo)}`;
    return validDay(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  // 2025/04/15
  if ((m = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/))) {
    const [y, mo, d] = m.slice(1).map(Number);
    return mo >= 1 && mo <= 12 && validDay(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  // month precision: 04/2025, 4.2025, 04-2025
  if ((m = s.match(/^(\d{1,2})[/.\-](\d{4})$/))) {
    const [mo, y] = [Number(m[1]), Number(m[2])];
    return mo >= 1 && mo <= 12 ? `${y}-${pad(mo)}` : null;
  }
  // Apr 2025, April-2025, APR.2025
  if ((m = s.match(/^([A-Za-z]{3,9})[\s.\-/]*(\d{4})$/))) {
    const mo = monthOf(m[1]);
    return mo ? `${Number(m[2])}-${pad(mo)}` : null;
  }
  // 15 Apr 2025, 15-APR-2025, 15 April, 2025
  if ((m = s.match(/^(\d{1,2})[\s.\-/]*([A-Za-z]{3,9})[\s.\-/,]*(\d{4})$/))) {
    const [d, mo, y] = [Number(m[1]), monthOf(m[2]), Number(m[3])];
    return mo && validDay(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  // Apr 15, 2025
  if ((m = s.match(/^([A-Za-z]{3,9})[\s.\-]+(\d{1,2}),?\s+(\d{4})$/))) {
    const [mo, d, y] = [monthOf(m[1]), Number(m[2]), Number(m[3])];
    return mo && validDay(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  // a/b/YYYY: decidable only when one side can't be a month (or both are equal)
  if ((m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/))) {
    const [a, b, y] = m.slice(1).map(Number);
    let d;
    let mo;
    if (a === b) [d, mo] = [a, b];
    else if (a > 12 && b <= 12) [d, mo] = [a, b];
    else if (b > 12 && a <= 12) [d, mo] = [b, a];
    else return null; // ambiguous
    return mo >= 1 && validDay(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  return null; // two-digit years and anything else: never guessed
}

/** A date value as stored on invoices: { raw, iso } (iso null when ambiguous). */
export const dateValue = (raw) => {
  const r = raw === null || raw === undefined ? null : String(raw).trim() || null;
  return { raw: r, iso: r ? normalizeDate(r) : null };
};
