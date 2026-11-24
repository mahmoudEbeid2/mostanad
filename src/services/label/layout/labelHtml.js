import { SECTION_TITLES } from "./layoutSpec.js";

// labelData → the printable sections, and the sections → one self-contained
// HTML page the renderer lays out. Only what labelData holds is printed: an
// empty field prints nothing (it is listed in `empty`), never a placeholder —
// except the batch / expiry line, which is a blank to fill on the production
// line by design (a label is printed before its batch exists).

const RTL = /[֐-ࣿ]/;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** LocalizedText (or a plain string) → the text in `lang`, else its primary, else any. */
export function textOf(v, lang) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v !== "object") return String(v);
  const t = v.translations || {};
  return String(t[lang] ?? t[v.primary] ?? Object.values(t)[0] ?? "").trim();
}
const list = (arr, lang) => (Array.isArray(arr) ? arr.map((x) => textOf(x, lang)).filter(Boolean) : []);

/** "Calves, Lambs & Kids." → "calves lambs kids" — for comparing lines, never printed. */
const JOINERS = new Set(["and", "or", "&", "و", "او", "أو"]);
export const normLine = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, "") // Arabic diacritics
    .split(/[^\p{L}\p{N}%&]+/u)
    .filter((w) => w && !JOINERS.has(w))
    .join(" ");
const words = (s) => new Set(normLine(s).split(" ").filter(Boolean));

/**
 * The same text printed twice (client report 24 Nov: the Indications paragraph
 * and "Calves, Lambs, Kids, Poultry" each twice). Across the label, a line
 * equal to one already printed is dropped; within a section, a line whose
 * words all appear in one earlier line of that section (the species list
 * inside the indications paragraph, aimOfUse repeated in indications) is
 * dropped too. Short lines (one word) only drop on an exact repeat.
 */
export function dedupeSections(sections) {
  const seen = new Set();
  return sections.map((s) => {
    if (s.key === "batch") return s;
    const kept = [];
    for (const line of s.lines) {
      const n = normLine(line);
      if (!n) continue;
      if (seen.has(n)) continue;
      const w = words(line);
      if (w.size > 1 && kept.some((k) => { const kw = words(k); return kw.size > w.size && [...w].every((x) => kw.has(x)); })) continue;
      // an earlier, shorter line this one fully contains is the repeat: keep the longer one
      for (let i = kept.length - 1; i >= 0; i--) {
        const kw = words(kept[i]);
        if (kw.size > 1 && kw.size < w.size && [...kw].every((x) => w.has(x))) {
          seen.delete(normLine(kept[i]));
          kept.splice(i, 1);
        }
      }
      seen.add(n);
      kept.push(line);
    }
    return { ...s, lines: kept };
  });
}

/**
 * → { sections: [{ key, title, lines: [string] }], empty: [labelData field] }.
 * `lang` picks the translation; `titles` the language of the section headings.
 */
export function sectionsFromLabelData(labelData = {}, { lang = "en" } = {}) {
  const d = labelData || {};
  const empty = [];
  const take = (field, value) => {
    const s = Array.isArray(value) ? value : value ? [value] : [];
    if (!s.length) empty.push(field);
    return s;
  };
  const name = take("productName", textOf(d.productName, lang));
  const form = [textOf(d.pharmaceuticalForm, lang), textOf(d.strength, lang)].filter(Boolean).join(" · ");
  const ingredients = (Array.isArray(d.activeIngredients) ? d.activeIngredients : [])
    .map((i) => [textOf(i, lang), [i.amount, i.unit].filter(Boolean).join(" ")].filter(Boolean).join(" "))
    .filter(Boolean);
  const analysis = d.analysis?.items?.length ? [`${d.analysis.basis ? `${d.analysis.basis}: ` : ""}${d.analysis.items.map((x) => `${x.name} ${x.value}`).join(", ")}`] : [];
  const species = d.targetAnimalSpecies?.list?.length ? d.targetAnimalSpecies.list.filter((x) => x && x !== "Unknown").join(", ") : "";
  const keepOut = d.keepOutOfReachOfChildren === true ? [lang === "ar" ? "يحفظ بعيداً عن متناول الأطفال" : "Keep out of the reach of children"] : [];
  const sections = [
    { key: "productName", lines: [...name, ...(form ? [form] : [])] },
    { key: "composition", lines: [...take("activeIngredients", ingredients), ...list(d.excipients, lang), ...analysis] },
    { key: "indications", lines: [...take("aimOfUse", textOf(d.aimOfUse, lang)), ...list(d.indications, lang), ...take("targetAnimalSpecies", species)] },
    { key: "dosage", lines: [...take("directionOfUse", textOf(d.directionOfUse, lang)), ...(textOf(d.routeOfAdministration, lang) ? [textOf(d.routeOfAdministration, lang)] : [])] },
    { key: "withdrawal", lines: take("withdrawalPeriod", textOf(d.withdrawalPeriod, lang)) },
    { key: "storage", lines: [...take("storage", textOf(d.storage, lang)), ...[textOf(d.shelfLifeAfterOpening, lang), textOf(d.netWeight, lang), textOf(d.packaging, lang)].filter(Boolean)] },
    { key: "warnings", lines: [textOf(d.contraindications, lang), ...list(d.warnings, lang), textOf(d.sideEffects, lang), ...list(d.userSafety, lang), ...keepOut].filter(Boolean) },
    { key: "registration", lines: take("registrationNumber", d.registrationNumber ? String(d.registrationNumber) : "") },
    { key: "batch", lines: [lang === "ar" ? "رقم التشغيلة: ________   تاريخ الإنتاج: ________   تاريخ الانتهاء: ________" : "Batch No.: ________   Mfg.: ________   Exp.: ________"] },
    { key: "company", lines: [textOf(d.manufacturer, lang), textOf(d.marketingAuthorisationHolder, lang), textOf(d.importer, lang), textOf(d.countryOfProduction, lang)].filter(Boolean) },
  ];
  const titles = SECTION_TITLES[lang] || SECTION_TITLES.en;
  return { sections: dedupeSections(sections).map((s) => ({ ...s, title: titles[s.key] })), empty };
}

/**
 * The page the renderer fits: #label is the page (exact mm), #flow its content
 * box. Font size and columns are set by the fit script through --fs / --cols.
 */
export function buildLabelHtml({ sections, layout, lang = "en" }) {
  const { widthMm: W, heightMm: H, marginsMm: m, fontFamily } = layout;
  const order = layout.sections.filter((s) => s.enabled).map((s) => s.key);
  const byKey = Object.fromEntries(sections.map((s) => [s.key, s]));
  const rtl = lang === "ar";
  const body = order
    .map((k) => byKey[k])
    .filter((s) => s && s.lines.length)
    .map((s) => {
      const head = s.key === "productName" ? "" : `<div class="h">${esc(s.title)}</div>`;
      const lines = s.lines.map((l) => `<div class="l" dir="${RTL.test(l) ? "rtl" : "auto"}">${esc(l)}</div>`).join("");
      return `<section class="sec" data-key="${s.key}">${head}${lines}</section>`;
    })
    .join("\n");
  return `<!doctype html><html lang="${esc(lang)}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><style>
@page{size:${W}mm ${H}mm;margin:0}
html,body{margin:0;padding:0;background:#fff}
*{box-sizing:border-box}
#label{width:${W}mm;height:${H}mm;padding:${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;position:relative;overflow:visible;background:#fff;color:#000;font-family:${fontFamily};}
#flow{height:100%;font-size:var(--fs,9pt);line-height:1.22;column-count:var(--cols,1);column-gap:2.5mm;column-fill:auto;}
.sec{margin:0 0 0.55em 0;break-inside:auto}
.sec[data-key="productName"]{font-size:1.55em;font-weight:700;line-height:1.15;break-inside:avoid;column-span:all;margin-bottom:0.4em}
.sec[data-key="productName"] .l+.l{font-size:var(--fs,9pt);font-weight:400}
.h{font-weight:700;break-after:avoid}
.l{white-space:pre-wrap;overflow-wrap:anywhere}
.sec[data-key="warnings"] .l{font-weight:600}
</style></head><body><div id="label" data-page="1"><div id="flow">
${body}
</div></div></body></html>`;
}
