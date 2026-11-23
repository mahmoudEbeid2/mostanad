// Grounding: an answer may only name entities, and state numbers, that came
// from tool results in this conversation (or from the user's own words). The
// model continuing a list "from memory" is exactly how invented products got
// shown; this check blocks such an answer instead of trusting the prompt.

// Upper-case words the answer may use without a tool having returned them.
const ALLOWED_CAPS = new Set([
  "COA", "FSC", "COO", "GMP", "PDF", "PNG", "JPEG", "CSV", "API", "EDA", "SFDA", "MOHAP", "ISO", "USD", "EGP", "SAR", "AED", "AI", "OK", "UTC", "HTML", "ID", "URL",
  "PASS", "FAIL", "NEEDS_REVIEW", "UNVERIFIABLE", "POM", "OTC", "VFD", "TODO", "NOTE", "CAIRO", "FAQ", "KG", "MG", "ML", "IU", "PH",
]);
const ARABIC_DIACRITICS = /[ً-ْـ]/g;

/** Lower-cased, Arabic-folded text for substring checks. */
export function fold(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(ARABIC_DIACRITICS, "")
    .replace(/[\s ]+/g, " ")
    .trim();
}

/** Every string and number inside a value, flattened (what a tool returned). */
export function factsOf(value, out = [], depth = 0) {
  if (value === null || value === undefined || depth > 10) return out;
  if (typeof value === "string" || typeof value === "number") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) factsOf(v, out, depth + 1);
  else if (typeof value === "object") for (const v of Object.values(value)) factsOf(v, out, depth + 1);
  return out;
}

/** The corpus answers are checked against: folded facts, numbers kept as a set too. */
export function corpusOf(texts) {
  const joined = fold(texts.join("\n"));
  const numbers = new Set((joined.match(/\d+(?:\.\d+)?/g) || []).map(normNumber));
  return { text: joined, numbers };
}

const normNumber = (n) => String(Number(String(n).replace(/,/g, "")));

const stripLinks = (s) => s.replace(/\[([^\]\n]+)\]\(entity:[^)]+\)/g, " ").replace(/`[^`]*`/g, " ");

// Labels are never entities (QA 2026-11-23: "الوصف:", "المكونات النشطة:", "conversion:", "P95", step
// names and field names blocked correct answers): text ending with ":" or followed by ":", field names
// (Arabic / English / camelCase) and metric names. Only what LOOKS like a product name or code is
// checked: a run of 3+ capitals, or letters together with a digit (AMINOVITA, VITA-K3, AD3E, SG-12).
const METRIC = /^(?:P\d{2,3}(?:\.\d)?|AVG|MAX|MIN|SUM|COUNT|TOTAL|RATE|ROI|KPI|SLA|ETA|ISO\d*)$/i;
let knownLabels = new Set();
/** Field / column / metric names (Arabic and English) that are labels, never entities. */
export function setKnownLabels(labels) {
  knownLabels = new Set([...labels].map((l) => fold(l).replace(/[:：]\s*$/, "")).filter(Boolean));
}
const looksLikeCode = (v) => /[A-Z]{3,}/.test(v) || (/[A-Za-z]/.test(v) && /\d/.test(v));
const isLabel = (v, after = "") =>
  /[:：]\s*$/.test(v) || /^\s*[:：]/.test(after) || knownLabels.has(fold(v).replace(/[:：]\s*$/, "")) || /^[a-z]+(?:[A-Z][a-z0-9]+)+$/.test(v.trim()) || METRIC.test(v.trim());

/** Names and codes the answer states (bold names, CODES / UPPER-CASE names) — never labels, field names or metrics. */
export function entityCandidates(answer) {
  const text = stripLinks(String(answer || ""));
  const out = new Set();
  for (const m of text.matchAll(/\*\*([^*\n]{2,80})\*\*/g)) {
    const v = m[1].trim();
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 3);
    if (/^[\d\s.,%٪]+$/.test(v) || v.split(/\s+/).length > 6 || isLabel(v, after) || !looksLikeCode(v)) continue;
    out.add(v);
  }
  for (const m of text.matchAll(/(?<![\w-])([A-Z][A-Z0-9]*(?:[-_/][A-Z0-9]+)*)(?![\w-])/g)) {
    const v = m[1];
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 3);
    if ((v.length >= 4 || /\d/.test(v)) && !ALLOWED_CAPS.has(v) && !/^[A-Z]$/.test(v) && !isLabel(v, after)) out.add(v);
  }
  return [...out];
}

/** Numbers ≥ 2 the answer states (not percentages it may compute, not inside dates). */
export function numberCandidates(answer) {
  const text = stripLinks(String(answer || "")).replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ").replace(/\d+(?:\.\d+)?\s*[%٪]/g, " ");
  return [...new Set((text.match(/(?<![\w.])\d[\d,]*(?:\.\d+)?(?![\w])/g) || []).map(normNumber).filter((n) => Number(n) >= 2))];
}

/**
 * → { ok, unknown: [...] }. corpus: tool results of this conversation + the user's own messages.
 * Numbers are checked only when the turn made no tool call (data stated without asking the system).
 */
export function checkGrounding(answer, corpus, { toolCallsThisTurn = 0 } = {}) {
  const unknown = entityCandidates(answer).filter((e) => !corpus.text.includes(fold(e)));
  if (toolCallsThisTurn === 0) for (const n of numberCandidates(answer)) if (!corpus.numbers.has(n)) unknown.push(n);
  return { ok: unknown.length === 0, unknown };
}

/** Does the text contain a typed table, or a run of 4+ short list items? */
export function hasTypedList(text) {
  return stripTypedLists(text) !== String(text || "").trim();
}

/**
 * Lists and tables the model typed. With `shown` (the values of this turn's blocks), a run is removed
 * ONLY when those blocks already show it (QA 2026-11-23: one record's fields were stripped and only
 * "بيانات شركة Vetline هي:" was left). Without `shown`, every typed list goes — used to detect a list
 * typed without asking the system.
 */
export function stripTypedLists(text, shown = null) {
  const values = shown ? [...shown].map((v) => fold(v)).filter((v) => v.length >= 2) : null;
  const duplicates = (lines) => !values || lines.filter((l) => values.some((v) => fold(l).includes(v))).length * 2 >= lines.length;
  const lines = String(text || "").split("\n");
  const out = [];
  let run = [];
  let table = [];
  const flush = () => {
    if (run.length < 4 || !duplicates(run)) out.push(...run);
    const rows = table.filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l));
    if (table.length && values && !duplicates(rows)) out.push(...table);
    run = [];
    table = [];
  };
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (run.length) flush();
      table.push(line); // a markdown table row
      continue;
    }
    if (/^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line) && line.length <= 160) {
      if (table.length) flush();
      run.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
