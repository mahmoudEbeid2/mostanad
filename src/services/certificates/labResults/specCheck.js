// Is a lab result inside its specification? (results grid, item 4). Pure and
// conservative: only a single number checked against a numeric range or limit
// is judged; anything else ("Complies", "Clear liquid", two numbers) is null —
// not judged, never "in spec" by default.

const NUM = String.raw`[-+]?\d+(?:[.,]\d+)?`;

/** "1,5" / "1.5" / "12.0%" → 1.5 / 12; several numbers or none → null. */
export function singleNumber(s) {
  const t = String(s ?? "").trim();
  const all = t.match(new RegExp(NUM, "g")) || [];
  if (all.length !== 1) return null;
  // a value is a number with at most a unit around it, not a sentence that contains one
  if (t.replace(all[0], "").replace(/[\s%a-zA-Zµ°/.]+/g, "").length) return null;
  const n = Number(all[0].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const num = (s) => Number(String(s).replace(",", "."));

/** A specification → { min?, max?, minExclusive?, maxExclusive? } or null when it isn't numeric. */
export function parseSpec(spec) {
  const s = String(spec ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  let m = s.match(new RegExp(`(${NUM})\\s*(?:±|\\+/-)\\s*(${NUM})`));
  if (m) return { min: num(m[1]) - num(m[2]), max: num(m[1]) + num(m[2]) };
  m = s.match(new RegExp(`(${NUM})\\s*%?\\s*(?:-|–|—|to|~)\\s*(${NUM})`, "i"));
  if (m && num(m[1]) <= num(m[2])) return { min: num(m[1]), max: num(m[2]) };
  m = s.match(new RegExp(`(?:≤|<=|=<|\\bmax(?:imum)?\\.?|\\bNMT\\b|not more than|\\bup to\\b)\\s*:?\\s*(${NUM})`, "i"));
  if (m) return { max: num(m[1]) };
  m = s.match(new RegExp(`(?:<)\\s*(${NUM})`));
  if (m) return { max: num(m[1]), maxExclusive: true };
  m = s.match(new RegExp(`(?:≥|>=|=>|\\bmin(?:imum)?\\.?|\\bNLT\\b|not less than|\\bat least\\b)\\s*:?\\s*(${NUM})`, "i"));
  if (m) return { min: num(m[1]) };
  m = s.match(new RegExp(`(?:>)\\s*(${NUM})`));
  if (m) return { min: num(m[1]), minExclusive: true };
  return null;
}

/** → true (inside), false (outside), null (not judged). */
export function inSpec(value, spec) {
  const v = singleNumber(value);
  const p = parseSpec(spec);
  if (v === null || !p) return null;
  if (p.min !== undefined && (p.minExclusive ? v <= p.min : v < p.min)) return false;
  if (p.max !== undefined && (p.maxExclusive ? v >= p.max : v > p.max)) return false;
  return true;
}
