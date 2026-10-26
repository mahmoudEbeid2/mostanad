import { normalizeEvidence, normalizeWithMap, findOccurrences, pageAt } from "../dataNeeds/evidenceVerifier.js";
import { normBatch, normLabel } from "./batchResults.js";

// Supplier COA verification (item 4, owner 2026-10-26). The model reads a supplier's
// certificate of analysis / lab report and says, per batch, which result it prints with
// a quote. CODE accepts a value only when:
//   - the batch number is printed in the document (as a whole token, not inside a longer one)
//     and it is the batch number of a line of this invoice (same normalisation as the batch
//     results store; a line without a batch number can never match);
//   - the value is inside its quote, and the quote is in the document's text (page from code);
//   - a document printing several batches: the quote is on a page that prints this batch;
//   - the result is one these lines' certificates need, and the document doesn't give it
//     two different values.
// Everything else is rejected with its reason. Pure: no I/O, never throws on bad input.

const ALNUM = /[\p{L}\p{N}]/u;

/** Pages (1-based) on which `batchNo` is printed as a whole token. */
export function batchPages(text, normText, batchNo) {
  const pages = new Set();
  for (const o of findOccurrences(normText, batchNo)) {
    const before = text[o.start - 1];
    const after = text[o.end];
    if ((before && ALNUM.test(before)) || (after && ALNUM.test(after))) continue;
    pages.add(pageAt(text, o.start));
  }
  return pages;
}

/**
 * text:   the document's text with "=== Page N ===" markers (code's text layer, or a scan's transcription)
 * answer: the model's { batches: [{ batchNo, results: [{ labelKey, value, quote }] }] }
 * lines:  the invoice's lines [{ invoiceItemId, lineNo, productId, batchNo, labels: [{ labelKey, label }] }]
 * → { accepted: [{ batchNo, batchNorm, labelKey, label, value, quote, page, invoiceItemIds }], rejected: [{ batchNo, labelKey, value, reason }] }
 */
export function verifyCoa({ text, answer, lines }) {
  const accepted = [];
  const rejected = [];
  const reject = (b, r, reason) => rejected.push({ batchNo: b ?? null, labelKey: r?.labelKey ?? null, label: r?.label ?? null, value: r?.value ?? null, reason });
  if (!text) {
    for (const b of answer?.batches || []) for (const r of b?.results || []) reject(b?.batchNo, r, "the document has no text to check against");
    return { accepted, rejected };
  }
  const normText = normalizeWithMap(text);
  const batches = (Array.isArray(answer?.batches) ? answer.batches : []).slice(0, 50);
  // which batches the document really prints (decides whether pages must match)
  const printed = new Map();
  for (const b of batches) {
    const no = String(b?.batchNo ?? "").trim();
    if (normBatch(no) && !printed.has(normBatch(no))) printed.set(normBatch(no), batchPages(text, normText, no));
  }
  const printedCount = [...printed.values()].filter((p) => p.size).length;
  const noBatchLines = lines.filter((l) => !normBatch(l.batchNo));
  const candidates = [];
  for (const b of batches) {
    const batchNo = String(b?.batchNo ?? "").trim();
    const results = (Array.isArray(b?.results) ? b.results : []).slice(0, 100).map((r) => ({ labelKey: normLabel(r?.labelKey), value: r?.value === null || r?.value === undefined ? "" : String(r.value).trim().slice(0, 500), quote: String(r?.quote ?? "").trim().slice(0, 1000) }));
    const norm = normBatch(batchNo);
    const all = (reason) => results.forEach((r) => reject(batchNo || null, r, reason));
    if (!norm) {
      all("no batch number was given for these results");
      continue;
    }
    const pages = printed.get(norm);
    if (!pages?.size) {
      all(`batch ${batchNo} is not printed in the document`);
      continue;
    }
    const matched = lines.filter((l) => l.productId && normBatch(l.batchNo) === norm);
    if (!matched.length) {
      all(`batch ${batchNo} is not the batch number of any line of this invoice${noBatchLines.length ? ` (line${noBatchLines.length > 1 ? "s" : ""} ${noBatchLines.map((l) => l.lineNo).join(", ")} ha${noBatchLines.length > 1 ? "ve" : "s"} no batch number, so nothing can be matched to ${noBatchLines.length > 1 ? "them" : "it"})` : ""}`);
      continue;
    }
    if (new Set(matched.map((l) => l.productId)).size > 1) {
      all(`batch ${batchNo} is on lines of different products, so the document can't be tied to one of them`);
      continue;
    }
    const wanted = new Map(matched.flatMap((l) => l.labels || []).map((x) => [x.labelKey, x.label]));
    for (const r of results) {
      r.label = wanted.get(r.labelKey) ?? null;
      if (!r.label) {
        reject(batchNo, r, "not a lab result these certificates need");
        continue;
      }
      if (!r.value) {
        reject(batchNo, r, "no value");
        continue;
      }
      if (!r.quote) {
        reject(batchNo, r, "no quote");
        continue;
      }
      if (!normalizeEvidence(r.quote).includes(normalizeEvidence(r.value))) {
        reject(batchNo, r, "the value is not inside the quote");
        continue;
      }
      const occ = findOccurrences(normText, r.quote);
      if (!occ.length) {
        reject(batchNo, r, "the quote is not in the document");
        continue;
      }
      // several batches in one document: the result must be on a page printing this one
      const hit = printedCount > 1 ? occ.find((o) => pages.has(pageAt(text, o.start))) : occ[0];
      if (!hit) {
        reject(batchNo, r, `the quote is on a page that doesn't print batch ${batchNo}`);
        continue;
      }
      candidates.push({ batchNo, batchNorm: norm, labelKey: r.labelKey, label: r.label, value: r.value, quote: text.slice(hit.start, hit.end), page: pageAt(text, hit.start), invoiceItemIds: matched.map((l) => l.invoiceItemId) });
    }
  }
  // one value per batch and result: two different ones → neither
  const byKey = new Map();
  for (const c of candidates) {
    const k = `${c.batchNorm}|${c.labelKey}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }
  for (const group of byKey.values()) {
    const values = new Set(group.map((c) => normalizeEvidence(c.value)));
    if (values.size > 1) group.forEach((c) => reject(c.batchNo, c, `the document gives two different values for ${c.label} of batch ${c.batchNo}`));
    else accepted.push(group[0]);
  }
  return { accepted, rejected };
}
