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
    .replace(/[\s ]+/g, " ")
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

/** Names and codes the answer states (bold text, CODES / UPPER-CASE names, short list items). */
export function entityCandidates(answer) {
  const text = stripLinks(String(answer || ""));
  const out = new Set();
  for (const m of text.matchAll(/\*\*([^*\n]{2,80})\*\*/g)) {
    const v = m[1].trim();
    if (!/^[\d\s.,%٪]+$/.test(v) && v.split(/\s+/).length <= 6) out.add(v);
  }
  for (const m of text.matchAll(/(?<![\w-])([A-Z][A-Z0-9]*(?:[-_/][A-Z0-9]+)*)(?![\w-])/g)) {
    const v = m[1];
    if ((v.length >= 4 || /\d/.test(v)) && !ALLOWED_CAPS.has(v) && !/^[A-Z]$/.test(v)) out.add(v);
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

/**
 * Lists and tables are never typed by the model: markdown tables, and runs of
 * four or more short list items, are removed (the rows are shown as a table block).
 */
export function stripTypedLists(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length < 4) out.push(...run);
    run = [];
  };
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) continue; // a markdown table row
    if (/^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line) && line.length <= 160) {
      run.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
