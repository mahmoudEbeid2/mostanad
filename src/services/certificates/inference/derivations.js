import { normalizeEvidence } from "../dataNeeds/evidenceVerifier.js";

// The allow-listed derivations of tier I (plan.md §14.2). A "derived" value is
// accepted only when CODE, running the named derivation on the quoted inputs,
// reproduces it. Free-form reasoning is not a derivation. Pure, never throws.
//
//   unit_conversion   "120 g/L" → { to: "mg/L" } → "120000 mg/L"
//   select_from_list  one element of a listed value (targetSpecies[] → "Poultry")
//   join_list         a list rendered as text ("A 10 %, B 5 %")
//   normalize_case    upper | lower | title of a quoted text
//
// "Exactly" (§14.2) is read after evidence normalisation — case, unicode
// dashes, spaces — the same normalisation every P2 check uses; numbers must
// match exactly.

export const DERIVATIONS = ["unit_conversion", "select_from_list", "join_list", "normalize_case"];

// ── units ────────────────────────────────────────────────────────────────────
const UNITS = {
  kg: ["mass", 1e6], g: ["mass", 1e3], gr: ["mass", 1e3], mg: ["mass", 1], mcg: ["mass", 1e-3], µg: ["mass", 1e-3], ug: ["mass", 1e-3],
  l: ["volume", 1e3], lt: ["volume", 1e3], ltr: ["volume", 1e3], litre: ["volume", 1e3], liter: ["volume", 1e3], ml: ["volume", 1],
};
const unitOf = (u) => UNITS[String(u || "").toLowerCase()] || null;
/** "120 g/L" | "120 g per litre" | "1.5 kg" → { n, num, den? } | null */
export function parseQuantity(text) {
  const m = String(text || "").trim().match(/^([0-9]+(?:[.,][0-9]+)?)\s*([a-zµ]+)\s*(?:(?:\/|per)\s*([a-z]+))?$/i);
  if (!m || !unitOf(m[2]) || (m[3] && !unitOf(m[3]))) return null;
  return { n: Number(m[1].replace(",", ".")), num: m[2].toLowerCase(), den: m[3]?.toLowerCase() || null };
}
const round = (x) => Math.round(x * 1e9) / 1e9;
/** Converts a quantity to `to` ("mg/L", "g") → "120000 mg/L", or null when the dimensions differ. */
export function convertUnits(text, to) {
  const q = parseQuantity(text);
  const t = parseQuantity(`1 ${to}`);
  if (!q || !t) return null;
  const [qd, qf] = unitOf(q.num);
  const [td, tf] = unitOf(t.num);
  if (qd !== td || !!q.den !== !!t.den) return null;
  let n = (q.n * qf) / tf;
  if (q.den) {
    const [qdd, qdf] = unitOf(q.den);
    const [tdd, tdf] = unitOf(t.den);
    if (qdd !== tdd) return null;
    n = (n / qdf) * tdf;
  }
  return `${round(n)} ${t.num}${t.den ? `/${t.den}` : ""}`;
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (_m, sep, c) => sep + c.toUpperCase());
const same = (a, b) => normalizeEvidence(a) === normalizeEvidence(b);
const scalar = (v) => ["string", "number"].includes(typeof v);

/**
 * Re-runs a derivation. input: the value code read at the evidence path (a
 * string, or a list for select_from_list / join_list). params: the model's
 * parameters for the derivation. → the value code computes, or null.
 */
export function runDerivation(kind, input, params = {}) {
  switch (kind) {
    case "unit_conversion":
      return typeof input === "string" && params?.to ? convertUnits(input, String(params.to)) : null;
    case "normalize_case": {
      if (typeof input !== "string") return null;
      if (params?.case === "upper") return input.toUpperCase();
      if (params?.case === "lower") return input.toLowerCase();
      if (params?.case === "title") return titleCase(input);
      return null;
    }
    case "join_list": {
      if (!Array.isArray(input) || !input.length) return null;
      const keys = Array.isArray(params?.fields) ? params.fields.map(String) : null;
      const parts = input.map((el) => {
        if (scalar(el)) return String(el).trim();
        if (el && typeof el === "object" && keys?.length) {
          return keys
            .map((k) => {
              const own = Object.keys(el).find((x) => x.toLowerCase() === k.toLowerCase());
              return own !== undefined && scalar(el[own]) ? String(el[own]).trim() : "";
            })
            .filter(Boolean)
            .join(" ");
        }
        return "";
      });
      if (parts.some((p) => !p)) return null;
      return parts.join(typeof params?.separator === "string" ? params.separator : ", ");
    }
    default:
      return null; // select_from_list is checked by verifyDerived (membership, not a computed value)
  }
}

/** Does `value` follow from `input` by `kind`? → { ok, computed?, reason? } */
export function verifyDerived(kind, input, params, value) {
  if (!DERIVATIONS.includes(kind)) return { ok: false, reason: `"${kind}" is not an allowed derivation` };
  if (kind === "select_from_list") {
    if (!Array.isArray(input)) return { ok: false, reason: "the evidence path is not a list" };
    const hit = input.find((el) => scalar(el) && same(el, value));
    return hit !== undefined ? { ok: true, computed: String(hit).trim() } : { ok: false, reason: "the value is not one of the listed items" };
  }
  const computed = runDerivation(kind, input, params);
  if (computed === null) return { ok: false, reason: `code could not run ${kind} on the quoted input` };
  return same(computed, value) ? { ok: true, computed } : { ok: false, reason: `code computes “${computed}”, not “${value}”` };
}
