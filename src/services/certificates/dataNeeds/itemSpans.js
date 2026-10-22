import { findOccurrences, normalizeEvidence, pageAt } from "./evidenceVerifier.js";

// Where each invoice line sits in the stored invoice text (plan.md §6.1 "row
// scope"): InvoiceItem.textSpan = { page, start, end, via }. Code decides —
// the extractor's `rowText` is only a hint:
//   1. rowText found exactly once in the text           → via "row_text"
//   2. else the one text line holding the line's code, or its name (and,
//      when there are several, its batch no.)          → via "line_search"
//   3. otherwise no span: a line-level quote can't be tied to this line and
//      is refused (unless the invoice has a single line).
// Two lines never share a span: a span claimed by two lines is dropped for both.

const linesOf = (text) => {
  const out = [];
  let at = 0;
  for (const raw of text.split("\n")) {
    out.push({ start: at, end: at + raw.length, text: raw });
    at += raw.length + 1;
  }
  return out;
};

const has = (line, needle) => {
  const n = normalizeEvidence(needle);
  return n.length >= 2 && normalizeEvidence(line.text).includes(n);
};

function searchLine(lines, data) {
  const code = data?.code ? String(data.code) : null;
  const name = data?.name ? String(data.name) : null;
  const batch = data?.batchNo ? String(data.batchNo) : null;
  const rows = lines.filter((l) => !/^=== Page \d+ ===$/.test(l.text));
  for (const pick of [
    () => (code ? rows.filter((l) => has(l, code) && (!batch || has(l, batch))) : []),
    () => (code ? rows.filter((l) => has(l, code)) : []),
    () => (name && batch ? rows.filter((l) => has(l, name) && has(l, batch)) : []),
    () => (name ? rows.filter((l) => has(l, name)) : []),
  ]) {
    const hits = pick();
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null; // ambiguous at this level → a stricter level already failed; don't guess
  }
  return null;
}

/**
 * text: invoices.text_content · items: [{ id, data, rowText? }]
 * → Map(itemId → { page, start, end, via } | null)
 */
export function locateItemSpans(text, items) {
  const out = new Map();
  if (!text) {
    for (const it of items) out.set(it.id, null);
    return out;
  }
  const lines = linesOf(text);
  for (const it of items) {
    let span = null;
    if (it.rowText && String(it.rowText).trim()) {
      const occ = findOccurrences(text, it.rowText);
      if (occ.length === 1) span = { start: occ[0].start, end: occ[0].end, via: "row_text" };
    }
    if (!span) {
      const l = searchLine(lines, it.data);
      if (l) span = { start: l.start, end: l.end, via: "line_search" };
    }
    out.set(it.id, span ? { page: pageAt(text, span.start), ...span } : null);
  }
  // a span two lines both claim proves nothing about either
  const ids = [...out.keys()];
  const clash = new Set();
  for (const a of ids) {
    for (const b of ids) {
      const sa = out.get(a);
      const sb = out.get(b);
      if (a !== b && sa && sb && sa.start < sb.end && sb.start < sa.end) clash.add(a).add(b);
    }
  }
  for (const id of clash) out.set(id, null);
  return out;
}
