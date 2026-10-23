// Number normalisation, in code (plan.md §15.3 step 5; owner rules for A6.3).
// `amountRaw` is always kept exactly as printed; `amount` is parsed by explicit
// rules, never by a model:
//   - spaces between groups of three ("100 000 000")        → thousands
//   - "," before exactly three digits ("60,000")             → thousands; ",d"/",dd" → a decimal comma
//   - "." in several groups ("10.000.000")                   → thousands
//   - one "." before 1–2 (or 4+) digits ("13.6", "0.5")      → a decimal point
//   - one "." before exactly three digits ("70.000", "1.000") → AMBIGUOUS (70 or 70,000?)
// An ambiguous number is resolved, in order, by: the admin's confirmation for the
// catalogue → the product's OWN evidence (another number in the block written
// "10.000.000", or "up to 1.000 mL" in a "per 1 Litre" product: only thousands
// fills the basis) → the catalogue's majority, and then it is FLAGGED until the
// admin confirms the convention once for the whole catalogue.
// Pure: no I/O.

const NUM = /(?<![\w.,])(\d{1,3}(?:[  ]\d{3})+|\d+(?:[.,]\d+)*)(?![\w])/;
const UNIT_RE = /^\s*(i\.?\s?u\.?|iu|mcg|µg|μg|ug|mg|gm?s?|grams?|kg|kgs|ml|mL|litres?|liters?|ltr?|l|%|ppm|cfu|m\.?t\.?)(?![a-z])/i;

const UNIT_NORM = (u) => {
  const s = String(u || "").toLowerCase().replace(/\s|\./g, "");
  if (["iu"].includes(s)) return "IU";
  if (["mcg", "µg", "μg", "ug"].includes(s)) return "µg";
  if (s === "mg") return "mg";
  if (["g", "gm", "gms", "gram", "grams"].includes(s)) return "g";
  if (["kg", "kgs"].includes(s)) return "kg";
  if (s === "ml") return "mL";
  if (["l", "lt", "ltr", "litre", "litres", "liter", "liters"].includes(s)) return "L";
  if (s === "%") return "%";
  if (s === "ppm") return "ppm";
  if (s === "cfu") return "CFU";
  if (s === "mt") return "MT";
  return u ? String(u).trim() : null;
};

/** One number token → { value, ambiguous, kind } where kind says how it was read. */
export function readNumber(token, dotGroup3 = null) {
  const t = String(token).trim().replace(/ /g, " ");
  if (/^\d{1,3}( \d{3})+$/.test(t)) return { value: Number(t.replace(/ /g, "")), ambiguous: false, kind: "space_thousands" };
  if (/^\d+$/.test(t)) return { value: Number(t), ambiguous: false, kind: "plain" };
  const dots = (t.match(/\./g) || []).length;
  const commas = (t.match(/,/g) || []).length;
  if (dots && commas) {
    // the last separator is the decimal one: 1,234.5 / 1.234,5
    const lastDot = t.lastIndexOf(".");
    const lastComma = t.lastIndexOf(",");
    const dec = lastDot > lastComma ? "." : ",";
    const thou = dec === "." ? "," : ".";
    return { value: Number(t.split(thou).join("").replace(dec, ".")), ambiguous: false, kind: "mixed" };
  }
  if (commas) {
    if (/^\d{1,3}(,\d{3})+$/.test(t)) return { value: Number(t.replace(/,/g, "")), ambiguous: false, kind: "comma_thousands" };
    if (commas === 1 && /^\d+,\d{1,2}$/.test(t)) return { value: Number(t.replace(",", ".")), ambiguous: false, kind: "comma_decimal" };
    return { value: null, ambiguous: false, kind: "unreadable" };
  }
  if (dots > 1) {
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) return { value: Number(t.replace(/\./g, "")), ambiguous: false, kind: "dot_thousands_multi" };
    return { value: null, ambiguous: false, kind: "unreadable" };
  }
  // one dot
  const [int, frac] = t.split(".");
  if (frac.length !== 3 || /^0+$/.test(int)) return { value: Number(t), ambiguous: false, kind: "dot_decimal" }; // 13.6, 0.5, 84.0, 0.250
  const asThousands = Number(int + frac);
  const asDecimal = Number(t);
  if (dotGroup3 === "thousands") return { value: asThousands, ambiguous: true, kind: "dot_group3", resolvedAs: "thousands" };
  if (dotGroup3 === "decimal") return { value: asDecimal, ambiguous: true, kind: "dot_group3", resolvedAs: "decimal" };
  return { value: null, ambiguous: true, kind: "dot_group3", resolvedAs: null, readings: { thousands: asThousands, decimal: asDecimal } };
}

/** "200.000 mg" / "up to 1.000 mL" / "99% (990 gm)" → { token, unit, upTo } of the first amount, or null. */
export function amountToken(raw) {
  const s = String(raw ?? "");
  const m = NUM.exec(s);
  if (!m) return null;
  const after = s.slice(m.index + m[0].length);
  const um = UNIT_RE.exec(after);
  return { token: m[1], unit: um ? UNIT_NORM(um[1]) : null, upTo: /\bup\s*to\s*$/i.test(s.slice(0, m.index)), index: m.index };
}

const MASS_G = { µg: 1e-6, mg: 1e-3, g: 1, kg: 1000 };
const VOL_ML = { mL: 1, L: 1000 };

/** "Each 1 Litre contains:" / "Contains per mL:" / "Each 1 gm contains :" → { quantity, unit, raw } | null */
export function parseBasis(text) {
  const s = String(text || "");
  const m = /\b(?:each|per)\s*(\d+(?:[.,]\d+)?)?\s*(ml|mL|l|litre|liter|ltr|gm?|grams?|kg)\b|contains\s+per\s+(\d+(?:[.,]\d+)?)?\s*(ml|mL|l|litre|liter|gm?|grams?|kg)\b/i.exec(s);
  if (!m) return null;
  const qty = Number(String(m[1] || m[3] || "1").replace(",", "."));
  const unit = UNIT_NORM(m[2] || m[4]);
  return { quantity: qty, unit, raw: m[0] };
}

/** An amount in the basis's dimension (g for mass, mL for volume), or null when not comparable. */
function inBasisUnits(value, unit, basis) {
  if (!basis || value === null) return null;
  const bIsVol = VOL_ML[basis.unit] !== undefined;
  const bIsMass = MASS_G[basis.unit] !== undefined;
  const basisSize = bIsVol ? basis.quantity * VOL_ML[basis.unit] : bIsMass ? basis.quantity * MASS_G[basis.unit] : null;
  if (basisSize === null) return null;
  // a mass per volume is compared at 1 g/mL (water): 70,000 mg in 1 L is 70 g ≤ 1000 g; 70,000 g is not
  if (MASS_G[unit] !== undefined) return { amount: value * MASS_G[unit], basisSize };
  if (VOL_ML[unit] !== undefined && bIsVol) return { amount: value * VOL_ML[unit], basisSize };
  if (VOL_ML[unit] !== undefined && bIsMass) return { amount: value * VOL_ML[unit], basisSize };
  return null;
}

/**
 * The block's OWN evidence for "." + three digits: → "thousands" | "decimal" | null
 *  - a number written with several dot groups ("10.000.000") → thousands
 *  - "up to 1.000 mL" (a fill-up line) in a product whose basis is 1 L: only thousands fills it
 *  - a leading-zero "0.250" → the block writes decimals with three places → decimal
 */
export function blockEvidence(text, basis) {
  const s = String(text || "");
  if (/(?<![\d.,])\d{1,3}(?:\.\d{3}){2,}(?![\d.,])/.test(s)) return { dotGroup3: "thousands", why: "a number written with several dot groups" };
  const fill = /up\s*to\s*[\t ]*(\d{1,3}\.\d{3})\s*(ml|mL|l|litre|liter)\b/i.exec(s) || /up\s*to\b[^\n]*?\t(\d{1,3}\.\d{3})\s*(ml|mL|l)\b/i.exec(s);
  if (fill && basis) {
    const r = readNumber(fill[1], "thousands");
    const asThousands = inBasisUnits(r.value, UNIT_NORM(fill[2]), basis);
    const asDecimal = inBasisUnits(readNumber(fill[1], "decimal").value, UNIT_NORM(fill[2]), basis);
    if (asThousands && asThousands.amount === asThousands.basisSize) return { dotGroup3: "thousands", why: `"up to ${fill[1]} ${fill[2]}" fills the ${basis.quantity} ${basis.unit} basis only when "." groups thousands` };
    if (asDecimal && asDecimal.amount === asDecimal.basisSize) return { dotGroup3: "decimal", why: `"up to ${fill[1]} ${fill[2]}" fills the ${basis.quantity} ${basis.unit} basis as a decimal` };
  }
  if (/(?<![\d.,])0\.\d{3}(?![\d.,])/.test(s)) return { dotGroup3: "decimal", why: "a leading-zero number with three decimals" };
  return null;
}

/**
 * One ingredient's printed amount → { amountRaw, amount, unit, ambiguous, numberRead, flags[] }.
 * convention: { dotGroup3: "thousands"|"decimal", source } — the admin's choice, the block's
 * own evidence, or the catalogue majority (then the value is flagged ambiguous).
 */
export function normaliseAmount(amountRaw, { basis = null, convention = null } = {}) {
  const raw = amountRaw === null || amountRaw === undefined ? null : String(amountRaw).trim();
  const flags = [];
  if (!raw) return { amountRaw: null, amount: null, unit: null, flags };
  const tok = amountToken(raw);
  if (!tok) return { amountRaw: raw, amount: null, unit: null, flags: [{ code: "placeholder_amount", message: `"${raw}" is not an amount — never stored as one` }], placeholder: true };
  const r = readNumber(tok.token, convention?.dotGroup3 || null);
  if (r.value === null && !r.ambiguous) flags.push({ code: "unreadable_number", message: `"${tok.token}" can't be read as a number` });
  if (r.ambiguous && convention?.source !== "admin" && convention?.source !== "block") {
    flags.push({
      code: "ambiguous_number",
      message: r.resolvedAs ? `"${tok.token}" read as ${r.resolvedAs === "thousands" ? r.value.toLocaleString("en-US") : r.value} (the catalogue's usual "." — confirm the convention)` : `"${tok.token}" can be ${r.readings?.thousands} or ${r.readings?.decimal}`,
      token: tok.token,
    });
  }
  const cmp = r.value !== null ? inBasisUnits(r.value, tok.unit, basis) : null;
  if (cmp && cmp.amount > cmp.basisSize + 1e-9) flags.push({ code: "amount_exceeds_basis", message: `${raw} is more than the ${basis.quantity} ${basis.unit} it is part of` });
  return { amountRaw: raw, amount: r.value, unit: tok.unit, ...(tok.upTo ? { upTo: true } : {}), numberRead: r.kind, ...(r.resolvedAs ? { readAs: r.resolvedAs } : {}), flags };
}

/** The catalogue-level majority of the blocks' own evidence → "thousands" | "decimal" (thousands when none). */
export function majorityConvention(evidences) {
  const n = { thousands: 0, decimal: 0 };
  for (const e of evidences) if (e?.dotGroup3) n[e.dotGroup3]++;
  return { dotGroup3: n.decimal > n.thousands ? "decimal" : "thousands", votes: n };
}
