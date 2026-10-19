// Deterministic invoice-quantity normalisation (review #4), the sibling of
// dateNormalizer.js: the raw text is always kept, and a number is produced
// ONLY when the text means one number. "1.250" / "1,250" is 1250 in one
// convention and 1.25 in the other → null + ambiguous (the reviewer fixes it),
// exactly like "03/04/2025".
//
//   "1,250.50"  → 1250.5     both separators: the last one is the decimal
//   "1.250,50"  → 1250.5
//   "1,250,000" → 1250000    the same separator twice: thousands
//   "12,5" "12.50" → 12.5    one separator, not followed by exactly 3 digits: decimal
//   "1 250"     → 1250       space (incl. no-break / thin) before 3 digits: thousands
//   "0,250" "1250.500" → decimal — a thousands group can't follow "0" or 4+ digits
//   "1.250" "1,250" → null, ambiguous

const GROUPED = (sep) => new RegExp(`^[1-9]\\d{0,2}(?:\\${sep}\\d{3})+$`);

/** → { value: number|null, ambiguous: boolean } */
export function normalizeQuantity(raw) {
  if (raw === null || raw === undefined) return { value: null, ambiguous: false };
  if (typeof raw === "number") return { value: Number.isFinite(raw) ? raw : null, ambiguous: false };
  let s = String(raw).trim().replace(/[\s  ](?=\d{3}(?!\d))/g, "");
  if (!s) return { value: null, ambiguous: false };
  const sign = /^[-+]/.test(s) ? s[0] : "";
  s = s.slice(sign.length);
  if (!/^\d[\d.,]*$/.test(s) || /[.,]$/.test(s)) return { value: null, ambiguous: false };

  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  let digits;
  if (dots && commas) {
    const dec = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const thou = dec === "." ? "," : ".";
    const [int, frac, ...rest] = s.split(dec);
    if (rest.length || frac.includes(thou) || !GROUPED(thou).test(int)) return { value: null, ambiguous: false };
    digits = `${int.split(thou).join("")}.${frac}`;
  } else if (dots + commas === 0) {
    digits = s;
  } else {
    const sep = dots ? "." : ",";
    if (dots + commas > 1) {
      if (!GROUPED(sep).test(s)) return { value: null, ambiguous: false };
      digits = s.split(sep).join("");
    } else {
      const [int, frac] = s.split(sep);
      if (frac.length === 3 && GROUPED(sep).test(s)) return { value: null, ambiguous: true };
      digits = `${int}.${frac}`;
    }
  }
  const n = Number(sign + digits);
  return { value: Number.isFinite(n) ? n : null, ambiguous: false };
}
