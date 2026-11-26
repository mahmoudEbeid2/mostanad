// Pack sizes (Phase 4, 28 Nov): production QA asked "OLIGOVET 100ML" + "OLIGOVET 1L" — both lines were
// linked to "OLIGOVET · 100mL", the 1L pack was lost, and "100ML" didn't match "100mL". One normalizer,
// used wherever a pack is compared (requests, invoices, Express, the harvest, the chat):
//   case and spelling   ML / ml / mL · L / LT / Ltr / Liter / لتر · G / gm / gr / جم · KG / kg / كجم / كيلو · mg
//   numbers             "1,000" = 1000 · "1.5" · Arabic digits ١٠٠
//   one scale           1 L = 1000 mL · 1 kg = 1000 g · 1 g = 1000 mg → compared in mL / mg
// Pure.

const AR_DIGITS = /[٠-٩۰-۹]/g;
const toLatin = (s) => String(s ?? "").replace(AR_DIGITS, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d) >= 0 ? "٠١٢٣٤٥٦٧٨٩".indexOf(d) : "۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/٫/g, ".").replace(/٬/g, ",");

// unit spelling → [display, base unit, factor to base]
const UNITS = [
  [/^(?:ml|mls|millilitres?|milliliters?|مل|مللي|ملي)$/i, ["mL", "mL", 1]],
  [/^(?:cc)$/i, ["mL", "mL", 1]],
  [/^(?:l|lt|ltr|ltrs|litres?|liters?|لتر|لترات|ل)$/i, ["L", "mL", 1000]],
  [/^(?:mg|milligrams?|مجم|ملجم)$/i, ["mg", "mg", 1]],
  [/^(?:g|gm|gms|gr|grams?|grammes?|جم|جرام|غ|غرام)$/i, ["g", "mg", 1000]],
  [/^(?:kg|kgs|kilos?|kilograms?|كجم|كيلو|كغ|كيلوجرام)$/i, ["kg", "mg", 1000000]],
];
const unitOf = (u) => UNITS.find(([re]) => re.test(String(u || "").trim()))?.[1] || null;

// "1,000" → 1000 (a group of 3 after the comma), "1,5" → 1.5, "1.5" → 1.5
function numberOf(raw) {
  const s = String(raw).trim();
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ""));
  if (/^\d+,\d{1,2}$/.test(s)) return Number(s.replace(",", "."));
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const PACK_RE = /(\d[\d.,]*)\s*(ml|mls|cc|l|lt|ltr|ltrs|litres?|liters?|mg|g|gm|gms|gr|grams?|kg|kgs|kilos?|مل|مللي|ملي|لتر|لترات|مجم|ملجم|جم|جرام|غرام|كجم|كيلو|كغ)(?![a-z؀-ۿ])/i;

/** "100ML" / "1 Ltr" / "١ لتر" / "1,000 mL" → { amount, unit, base, display } | null */
export function parsePack(text) {
  const s = toLatin(text);
  const m = s.match(PACK_RE);
  if (!m) return null;
  const amount = numberOf(m[1]);
  const u = unitOf(m[2]);
  if (amount === null || !u) return null;
  const [unit, baseUnit, factor] = u;
  const show = Number.isInteger(amount) ? String(amount) : String(amount);
  return { amount, unit, base: { value: Math.round(amount * factor * 1000) / 1000, unit: baseUnit }, display: `${show} ${unit}` };
}

/** The pack as stored and shown: "100 mL", "1 L"; anything that isn't a pack size stays as written */
export const displayPack = (text) => parsePack(text)?.display || (String(text ?? "").trim() || null);

/** A key two equal packs share: "1 L" and "1000 ml" → "1000mL" */
export const packKey = (text) => {
  const p = parsePack(text);
  return p ? `${p.base.value}${p.base.unit}` : String(text ?? "").toLowerCase().replace(/\s+/g, "");
};

/** Are these the same pack? (both readable and equal on one scale, or the same text) */
export const samePack = (a, b) => {
  if (!a || !b) return false;
  return packKey(a) === packKey(b);
};

/** "OLIGOVET 100ML" → { name: "OLIGOVET", pack: "100 mL" }; no pack → { name, pack: null } */
export function splitNamePack(text) {
  const s = String(text ?? "").trim();
  const latin = toLatin(s);
  const m = latin.match(new RegExp(`(?:^|\\s|[-–·(])${PACK_RE.source}\\)?\\s*$`, "i"));
  if (!m) return { name: s, pack: null };
  const cut = m.index + (/^[\s\-–·(]/.test(m[0]) ? 1 : 0);
  const name = s.slice(0, cut).replace(/[\s\-–·(]+$/, "").trim();
  return name ? { name, pack: parsePack(m[0]).display } : { name: s, pack: null };
}
