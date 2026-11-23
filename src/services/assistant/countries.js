// Countries the app works with, by ISO alpha-2 code, with Arabic and English names.
// A country the person names ("مصر", "Egypt", "eg") is stored as its code; the draft
// form offers them as a choice instead of free text (QA 2026-11-23: "مصر" was stored
// raw, and in the resize flow "البلد مصر" was dropped and the label showed "XX").

export const COUNTRIES = [
  ["EG", "مصر", "Egypt"],
  ["SA", "السعودية", "Saudi Arabia", ["المملكة العربية السعودية", "السعوديه", "ksa"]],
  ["AE", "الإمارات", "United Arab Emirates", ["الامارات", "uae", "emirates"]],
  ["KW", "الكويت", "Kuwait"],
  ["QA", "قطر", "Qatar"],
  ["BH", "البحرين", "Bahrain"],
  ["OM", "عمان", "Oman", ["سلطنة عمان"]],
  ["JO", "الأردن", "Jordan", ["الاردن"]],
  ["IQ", "العراق", "Iraq"],
  ["LB", "لبنان", "Lebanon"],
  ["SY", "سوريا", "Syria"],
  ["YE", "اليمن", "Yemen"],
  ["LY", "ليبيا", "Libya"],
  ["SD", "السودان", "Sudan"],
  ["TN", "تونس", "Tunisia"],
  ["DZ", "الجزائر", "Algeria"],
  ["MA", "المغرب", "Morocco"],
  ["PS", "فلسطين", "Palestine"],
  ["TR", "تركيا", "Turkey", ["türkiye"]],
  ["IN", "الهند", "India"],
  ["CN", "الصين", "China"],
];

const fold = (s) => String(s ?? "").toLowerCase().replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[ً-ْـ]/g, "").replace(/\s+/g, " ").trim();
const NAMES = COUNTRIES.flatMap(([code, ar, en, more = []]) => [code, ar, en, ...more].map((n) => [fold(n).replace(/^ال/, ""), code]));

/** "مصر" / "Egypt" / "eg" / "EG" → "EG"; null when it isn't a country we know. */
export function countryCode(text) {
  const t = fold(text).replace(/^ال/, "");
  if (!t) return null;
  return NAMES.find(([n]) => n === t)?.[1] ?? null;
}

/** The first country named in a text ("البلد مصر" → "EG"), or null. */
export function countryIn(text) {
  const t = ` ${fold(text)} `;
  for (const [n, code] of NAMES) if (n.length > 2 && (t.includes(` ${n} `) || t.includes(` ال${n} `))) return code;
  return null;
}

export const countryLabel = (code) => {
  const c = COUNTRIES.find((x) => x[0] === code);
  return c ? `${c[1]} / ${c[2]} (${code})` : code;
};
export const countryOptions = () => COUNTRIES.map(([code]) => ({ value: code, label: countryLabel(code) }));
