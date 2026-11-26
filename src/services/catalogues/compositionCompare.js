// Composition amounts compared on ONE basis (client workflow §2.5, 26 Nov): "0.1 mg/mL" on one
// source and "0.64 g" per 100 mL on another → "10 mg vs 640 mg per 100 mL". Pure; nothing is
// rounded into the stored values — both originals are kept, this is only what the reviewer reads.

const MASS = { kg: 1e6, g: 1000, gm: 1000, gr: 1000, mg: 1, mcg: 0.001, "µg": 0.001, "μg": 0.001, ug: 0.001 };
const VOLUME = { l: 1000, lt: 1000, ltr: 1000, litre: 1000, liter: 1000, ml: 1 };
const num = (s) => Number(String(s).replace(/,/g, ""));

/** "Each 1 mL contains" / "per 100 mL" / "Each 1 L contains" / "per kg" → { amount, unit: "mL" | "g" } | null */
export function parseBasis(text) {
  const m = String(text || "").match(/(?:each|per|every|contains\s+per)\s+([\d.,]*)\s*(kg|g|gm|ml|l|lt|ltr|litre|liter)\b/i);
  if (!m) return null;
  const n = m[1] ? num(m[1]) : 1;
  const u = m[2].toLowerCase();
  if (VOLUME[u]) return { amount: n * VOLUME[u], unit: "mL" };
  return { amount: n * MASS[u === "gm" ? "g" : u] / 1000, unit: "g" };
}

/** "0.1 mg/mL", "0.64 g", "15,000 IU", "q.s. to 1 mL" → { value, unit, per? } | null (an equivalent / carrier → null) */
export function parseAmount(text) {
  const t = String(text || "").trim();
  if (/^(?:ad|q\.?\s?s\.?|up\s+to)\b/i.test(t) || /not stated/i.test(t)) return null;
  const m = t.match(/^([\d.,]+)\s*(kg|g|gm|gr|mg|mcg|µg|μg|ug|iu|%)\s*(?:\/\s*([\d.,]*)\s*(kg|g|ml|l))?/i);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const per = m[4] ? parseBasis(`per ${m[3] || 1} ${m[4]}`) : null;
  return { value: num(m[1]), unit, per };
}

const toMg = (a) => (MASS[a.unit] !== undefined ? a.value * MASS[a.unit] : null);
const fmt = (n) => (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : String(Number(n.toPrecision(4))));

/**
 * Two amounts of one ingredient, each with its source's basis → the same basis.
 * → { a, b, basis: "per 100 mL", unit, text: "10 mg vs 640 mg per 100 mL", same } | null when not comparable (IU vs mg…)
 */
export function compareAmounts({ amount: aText, basis: aBasis }, { amount: bText, basis: bBasis }, { target = null } = {}) {
  const a = parseAmount(aText);
  const b = parseAmount(bText);
  if (!a || !b) return null;
  const ba = a.per || parseBasis(aBasis);
  const bb = b.per || parseBasis(bBasis);
  if (!ba || !bb || ba.unit !== bb.unit) return null;
  const goal = target ? parseBasis(target) : ba.unit === "mL" ? { amount: 100, unit: "mL" } : { amount: 100, unit: "g" };
  if (!goal || goal.unit !== ba.unit) return null;
  let va;
  let vb;
  let unit;
  if (a.unit === "iu" || b.unit === "iu" || a.unit === "%" || b.unit === "%") {
    if (a.unit !== b.unit) return null;
    [va, vb, unit] = [a.value, b.value, a.unit === "iu" ? "IU" : "%"];
  } else {
    [va, vb, unit] = [toMg(a), toMg(b), "mg"];
    if (va === null || vb === null) return null;
  }
  if (unit !== "%") {
    va = (va / ba.amount) * goal.amount;
    vb = (vb / bb.amount) * goal.amount;
  }
  const basis = `per ${fmt(goal.amount)} ${goal.unit}`;
  return { a: va, b: vb, unit, basis, same: Math.abs(va - vb) <= Math.max(Math.abs(va), Math.abs(vb)) * 0.005, text: `${fmt(va)} ${unit} vs ${fmt(vb)} ${unit} ${basis}` };
}
