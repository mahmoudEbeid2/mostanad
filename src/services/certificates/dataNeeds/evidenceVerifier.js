import { resolve } from "../paths/sourcePath.js";

// Evidence verification (plan.md P2, §6.1). An AI-found value is accepted only
// when code can see it written, verbatim after normalisation, where the model
// says it is:
//   invoice_text       — the quote is in the stored invoice text, the value is
//                        in the quote, and (row scope) the quote lies inside
//                        the right part of the text: the item's own row for
//                        line-level fields, outside every item row for header ones;
//   product_path       — code reads the path on the matched product; the value
//                        must exist and CODE's value replaces the model's;
//   product_json_text  — code reads the path to a string on the matched
//                        product; the quote is in that string and the value in the quote;
//   catalogue_text     — (A6, tier C) the quote is in the matched product's OWN linked
//                        catalogue block and the value in the quote; refused outright for
//                        a field that never comes from a catalogue (batch data / results).
// Pure: no I/O, never throws on bad input.

const DASHES = /[‐-―−﹘﹣－]/;
const QUOTES = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"', "‟": '"', "«": '"', "»": '"' };
const SEPARATOR = /[\s|]/; // " | " is the extractor's cell separator — it may be dropped in a quote

/** One original character → its normalised form ("" when it disappears). */
function normChar(ch) {
  if (SEPARATOR.test(ch)) return " ";
  if (DASHES.test(ch)) return "-";
  if (QUOTES[ch]) return QUOTES[ch];
  // Turkish dotted/dotless i: İ ı I i all compare equal (İ lower-cases to i + U+0307)
  if (ch === "İ" || ch === "ı") return "i";
  return ch
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents and the combining dot
    .replace(/\s+/g, " ");
}

/**
 * → { text, map } — `text` normalised (case, unicode dashes/quotes, Turkish i,
 * accents, whitespace and " | " collapsed); map[i] = the original index of normalised char i.
 */
export function normalizeWithMap(s) {
  const src = String(s ?? "");
  let text = "";
  const map = [];
  let i = 0;
  for (const ch of src) {
    const n = normChar(ch);
    for (const c of n) {
      if (c === " " && (text.length === 0 || text.endsWith(" "))) continue; // collapse
      text += c;
      map.push(i);
    }
    i += ch.length;
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

export const normalizeEvidence = (s) => normalizeWithMap(s).text;

/** Every original-text offset range [start, end) where normalised `needle` occurs. */
export function findOccurrences(haystack, needle) {
  const h = typeof haystack === "string" ? normalizeWithMap(haystack) : haystack;
  const n = normalizeEvidence(needle);
  if (!n) return [];
  const out = [];
  let from = 0;
  for (;;) {
    const at = h.text.indexOf(n, from);
    if (at < 0) break;
    out.push({ start: h.map[at], end: h.map[at + n.length - 1] + 1 });
    from = at + 1;
  }
  return out;
}

/** The 1-based page an offset lies on ("=== Page N ===" markers). */
export function pageAt(text, offset) {
  let page = 1;
  const re = /^=== Page (\d+) ===$/gm;
  let m;
  while ((m = re.exec(text)) && m.index <= offset) page = Number(m[1]);
  return page;
}

const inside = (occ, span) => span && occ.start >= span.start && occ.end <= span.end;

/**
 * Verifies one evidence entry.
 * ev:  { type, quote?, page?, path? }
 * ctx: { value, textContent, normText?, scope: "item"|"header", span?, otherSpans[], singleItem, product }
 * → { ok: true, value, provenance } | { ok: false, reason }
 */
export function verifyEvidence(ev, ctx) {
  const value = ctx.value === null || ctx.value === undefined ? "" : String(ctx.value).trim();
  switch (ev?.type) {
    case "invoice_text": {
      if (!ctx.textContent) return { ok: false, reason: "the invoice has no stored text to check against" };
      const quote = String(ev.quote ?? "").trim();
      if (!quote) return { ok: false, reason: "no quote" };
      if (!value) return { ok: false, reason: "no value" };
      if (!normalizeEvidence(quote).includes(normalizeEvidence(value))) return { ok: false, reason: "the value is not inside the quote" };
      const occ = findOccurrences(ctx.normText || ctx.textContent, quote);
      if (!occ.length) return { ok: false, reason: "the quote is not in the invoice text" };
      let hit;
      if (ctx.scope === "item") {
        // one line only: there is no other line's row to take a wrong value from, so a
        // per-line value printed below the table ("Analysis No: …") is that line's
        if (ctx.singleItem) hit = occ[0];
        else if (ctx.span) hit = occ.find((o) => inside(o, ctx.span));
        else return { ok: false, reason: "this line's row could not be located in the invoice text, so a quote can't be tied to it" };
        if (!hit) return { ok: false, reason: "the quote is not in this line's row of the invoice" };
      } else {
        hit = occ.find((o) => !(ctx.otherSpans || []).some((s) => o.start < s.end && o.end > s.start));
        if (!hit) return { ok: false, reason: "the quote is inside an item row, not in the invoice header/footer" };
      }
      return { ok: true, value, provenance: { kind: "invoice_text", quote: ctx.textContent.slice(hit.start, hit.end), page: pageAt(ctx.textContent, hit.start), start: hit.start, end: hit.end } };
    }
    case "product_path": {
      if (!ctx.product) return { ok: false, reason: "no matched product" };
      const path = `product.${String(ev.path ?? "").replace(/^product\./, "")}`;
      const r = resolve({ product: ctx.product }, path);
      if (r.error) return { ok: false, reason: `invalid path: ${r.error}` };
      if (!r.found || !["string", "number"].includes(typeof r.value)) return { ok: false, reason: "the product has no value at that path" };
      return { ok: true, value: String(r.value).trim(), provenance: { kind: "product_path", path: r.path } }; // code's value, not the model's
    }
    case "product_json_text": {
      if (!ctx.product) return { ok: false, reason: "no matched product" };
      const path = `product.${String(ev.path ?? "").replace(/^product\./, "")}`;
      const r = resolve({ product: ctx.product }, path);
      if (r.error) return { ok: false, reason: `invalid path: ${r.error}` };
      if (!r.found || typeof r.value !== "string") return { ok: false, reason: "the product has no text at that path" };
      const quote = String(ev.quote ?? "").trim();
      if (!quote || !value) return { ok: false, reason: "a quote and a value are needed" };
      if (!normalizeEvidence(r.value).includes(normalizeEvidence(quote))) return { ok: false, reason: "the quote is not in the product's text" };
      if (!normalizeEvidence(quote).includes(normalizeEvidence(value))) return { ok: false, reason: "the value is not inside the quote" };
      return { ok: true, value, provenance: { kind: "product_json_text", path: r.path, quote } };
    }
    case "catalogue_text": {
      if (!ctx.catalogueAllowed) return { ok: false, reason: "this field never comes from a catalogue (batch data, results, invoice values)" };
      const block = ctx.catalogueBlock;
      if (!block?.text) return { ok: false, reason: "the product has no linked catalogue block" };
      const quote = String(ev.quote ?? "").trim();
      if (!quote || !value) return { ok: false, reason: "a quote and a value are needed" };
      if (!normalizeEvidence(quote).includes(normalizeEvidence(value))) return { ok: false, reason: "the value is not inside the quote" };
      const occ = findOccurrences(block.text, quote);
      if (!occ.length) return { ok: false, reason: "the quote is not in this product's catalogue block" };
      return {
        ok: true,
        value,
        provenance: { tier: "C", kind: "catalogue_text", via: "gap_call", catalogueVersionId: block.versionId, blockId: block.id, page: block.page, quote: block.text.slice(occ[0].start, occ[0].end) },
      };
    }
    default:
      return { ok: false, reason: `unknown evidence type "${ev?.type}"` };
  }
}

/**
 * A gap answer → { verified, value?, provenance?, checks[] }. The value is
 * accepted when at least one evidence entry proves it; every entry's result is
 * kept (P7). Proofs rank in the owner's order: the DB (product_path — code's DB
 * value is what gets used) → the invoice → the product's text → its catalogue.
 */
const PROOF_ORDER = ["product_path", "invoice_text", "product_json_text", "catalogue_text"];
export function verifyAnswer(answer, ctx) {
  const evidence = Array.isArray(answer?.evidence) ? answer.evidence.slice(0, 5) : [];
  if (!answer?.found) return { verified: false, checks: [], reason: "not found" };
  if (!evidence.length) return { verified: false, checks: [], reason: "no evidence" };
  const normText = ctx.textContent ? normalizeWithMap(ctx.textContent) : null;
  const checks = evidence.map((ev) => ({ type: ev?.type, ...verifyEvidence(ev, { ...ctx, normText, value: answer.value }) }));
  const proof = PROOF_ORDER.map((t) => checks.find((c) => c.ok && c.type === t)).find(Boolean) || checks.find((c) => c.ok);
  if (!proof) return { verified: false, checks, reason: checks.map((c) => c.reason).join("; ") };
  return { verified: true, value: proof.value, provenance: proof.provenance, checks };
}
