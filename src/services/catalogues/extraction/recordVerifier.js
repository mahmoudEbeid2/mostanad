import { verifyBlockQuote, verifyBlockWord, specRows, parseSections } from "../catalogueSections.js";
import { normalizeEvidence } from "../../certificates/dataNeeds/evidenceVerifier.js";
import { normaliseAmount, parseBasis, amountToken } from "./numbers.js";
import { SCALAR_FIELDS } from "./catalogueExtractor.js";

// Verification (plan.md §15.3 step 4), in code. A value of the model's record is
// kept only when its quote is verbatim in THAT block and the value is inside
// the quote; anything else is dropped and flagged "unverified" (needs manual
// entry). Never a value from a neighbouring block. Text fields may leave out
// list glyphs ("• ", a line-opening "- ") — the words must still be exactly the
// printed ones. Species are checked one by one as printed words. A composition
// row WITH an amount must quote ONE printed line, and the amount must be the
// first number after the name on it (so a misread column can't pair a name with
// its neighbour's amount).
// Specifications come from code (the SPECIFICATIONS rows), not from the model.
// Pure: no I/O.

const PRODUCT_CODE = /^[A-Za-z0-9][A-Za-z0-9\-/.]{1,30}$/;
const inside = (outer, inner) => normalizeEvidence(outer).includes(normalizeEvidence(inner));

/** The composition basis printed in the block ("Each 1 Litre contains:"), by code. */
export function basisOf(block) {
  const comp = parseSections(block).find((s) => s.heading === "COMPOSITION");
  for (const l of comp?.lines || []) {
    const b = parseBasis(l.t);
    if (b) return { ...b, line: l.t.trim(), start: l.o, end: l.o + l.t.length };
  }
  return null;
}

/** The COMPOSITION section's text (what number evidence is read from). */
export const compositionText = (block) => {
  const comp = parseSections(block).filter((s) => ["COMPOSITION", "SPECIFICATIONS", "SPECIFICATION"].includes(s.heading));
  return comp.length ? comp.map((s) => block.text.slice(s.start, s.end)).join("\n") : block.text;
};

function verifyScalar(block, field, entry, flags) {
  if (!entry || entry.value === null || entry.value === undefined || !String(entry.value).trim()) return null;
  const value = String(entry.value).trim();
  let ok = verifyBlockQuote(block, entry.quote || value, value, { loose: true });
  // a long value with a short quote: the value itself is then the quote — it must be printed in THIS block, verbatim
  if (!ok.ok && entry.quote && value.length > String(entry.quote).length) ok = verifyBlockQuote(block, value, value, { loose: true });
  if (!ok.ok) {
    flags.push({ code: "unverified", field, message: `${field}: "${value.slice(0, 60)}" — ${ok.reason}; dropped, enter it by hand` });
    return null;
  }
  return { value, quote: { quote: ok.quote, start: ok.start, end: ok.end } };
}

/** The single printed line holding [start, end), or null when the quote spans lines. */
function lineOf(block, start, end) {
  const lineStart = block.text.lastIndexOf("\n", start - 1) + 1;
  const nl = block.text.indexOf("\n", start);
  const lineEnd = nl < 0 ? block.text.length : nl;
  return end <= lineEnd ? block.text.slice(lineStart, lineEnd) : null;
}

/** The amount printed right after `name` on its single line inside the COMPOSITION section, as printed — or null. */
function amountAfterName(block, start, end, name) {
  const line = lineOf(block, start, end);
  if (line === null) return null;
  const comp = parseSections(block).find((s) => s.heading === "COMPOSITION");
  if (!comp || start < comp.start || end > comp.end) return null;
  const at = line.toLowerCase().indexOf(name.toLowerCase());
  if (at < 0) return null;
  const m = /^[\s\t]*((?:up to\s*)?\d[\d\s.,]*\d?\s*(?:%|I\.U\.|IU|mg|mcg|µg|μg|gm|g|kg|mL|ml|L)\.?)(?=\s|$|\t|\))/i.exec(line.slice(at + name.length));
  return m ? m[1].trim() : null;
}

function verifyIngredient(block, ing, { basis, convention }, flags) {
  const amountRaw = ing?.amountRaw === null || ing?.amountRaw === undefined || !String(ing.amountRaw).trim() ? null : String(ing.amountRaw).trim();
  let name = String(ing?.name || "").trim();
  // "Threonine 65%" / "Choline chloride 70% feed grade" with amountRaw "65%" / "70%": the name is the part before its amount
  const cut = amountRaw ? name.toLowerCase().indexOf(amountRaw.toLowerCase()) : -1;
  if (cut > 0) name = name.slice(0, cut).trim();
  if (!name) return null;
  const ok = verifyBlockQuote(block, ing.quote || name, name, { loose: !amountRaw });
  if (!ok.ok) {
    flags.push({ code: "unverified", field: "activeIngredients", message: `ingredient "${name}" — ${ok.reason}; dropped` });
    return null;
  }
  const quote = { quote: ok.quote, start: ok.start, end: ok.end };
  if (!amountRaw) {
    // the model left the amount out: code copies it only from that ingredient's OWN composition line,
    // when the first thing after the name is an amount ("Choline chloride 70% feed grade") — copied, never inferred
    const printed = amountAfterName(block, ok.start, ok.end, name);
    if (printed) return verifyIngredient(block, { name, amountRaw: printed, quote: lineOf(block, ok.start, ok.end) }, { basis, convention }, flags);
    // a name without an amount needs no row: it can be quoted from running text over lines
    return { item: { name, amountRaw: null, amount: null, unit: null, basis: basis?.line || null }, quote };
  }
  const line = lineOf(block, ok.start, ok.end);
  if (line === null) {
    flags.push({ code: "unverified", field: "activeIngredients", message: `ingredient "${name}" — its quote spans several printed lines; dropped` });
    return null;
  }
  const n = normaliseAmount(amountRaw, { basis, convention });
  if (n.placeholder) {
    flags.push({ code: "placeholder_amount", field: "activeIngredients", message: `"${name}": "${amountRaw}" is not an amount — not stored; enter the amount if the catalogue prints one`, ingredient: name });
    return { item: { name, amountRaw: null, amount: null, unit: null, basis: basis?.line || null }, quote };
  }
  // the amount is the first number after the name on that printed line
  const normLine = normalizeEvidence(line);
  const at = normLine.indexOf(normalizeEvidence(name));
  const after = at >= 0 ? normLine.slice(at + normalizeEvidence(name).length) : "";
  const tok = amountToken(after);
  const want = amountToken(normalizeEvidence(amountRaw));
  if (!inside(ok.quote, amountRaw) || !tok || !want || tok.token !== want.token) {
    flags.push({ code: "unverified", field: "activeIngredients", message: `"${name}": amount "${amountRaw}" is not the amount printed after it on its line; amount dropped`, ingredient: name });
    return { item: { name, amountRaw: null, amount: null, unit: null, basis: basis?.line || null }, quote };
  }
  for (const f of n.flags) flags.push({ ...f, field: "activeIngredients", ingredient: name, message: `"${name}": ${f.message}` });
  return {
    item: { name, amountRaw: n.amountRaw, concentration: n.amountRaw, amount: n.amount, unit: n.unit, basis: basis?.line || null, ...(n.readAs ? { readAs: n.readAs } : {}), ...(n.upTo ? { upTo: true } : {}) },
    quote,
  };
}

/**
 * The model's record for one block → { isProduct, record, quotes, flags, categoryProposal }.
 * convention: { dotGroup3, source: admin|block|majority } for "." + three digits.
 */
export function verifyRecord(raw, block, { convention = null } = {}) {
  const flags = [];
  const record = {};
  const quotes = {};
  if (raw && raw.isProduct === false) flags.push({ code: "not_a_product", message: "The AI read this block as not a product (cover, index …) — check it" });
  for (const field of SCALAR_FIELDS) {
    if (field === "compositionBasis") continue;
    const v = verifyScalar(block, field, raw?.[field], flags);
    if (v) {
      record[field] = v.value;
      quotes[field] = v.quote;
    }
  }
  if (record.productCode && !PRODUCT_CODE.test(record.productCode)) {
    flags.push({ code: "unverified", field: "productCode", message: `productCode "${record.productCode}" doesn't look like a code; dropped` });
    delete record.productCode;
    delete quotes.productCode;
  }
  // the large-font title code found is the name when the model's isn't provable
  if (!record.name && block.title) {
    const ok = verifyBlockQuote(block, block.title.split(" ")[0], block.title.split(" ")[0]);
    if (ok.ok) {
      record.name = block.title;
      quotes.name = { quote: ok.quote, start: ok.start, end: ok.end, via: "title" };
    }
  }
  if (!record.name) flags.push({ code: "no_name", field: "name", message: "No verified product name — type it before applying" });

  // target species: each one a word printed in this block (its line is the quote)
  const ts = raw?.targetSpecies;
  if (ts?.values?.length) {
    const kept = [];
    const keptQuotes = [];
    const seen = new Set();
    for (const s of ts.values.map((x) => String(x).trim()).filter(Boolean)) {
      const key = s.toLowerCase().replace(/(?<=\w{3})(es|s)$/, "");
      if (seen.has(key)) continue;
      const ok = verifyBlockWord(block, s);
      if (ok.ok) {
        seen.add(key);
        kept.push(s);
        keptQuotes.push({ quote: ok.quote, start: ok.start, end: ok.end });
      } else flags.push({ code: "unverified", field: "targetSpecies", message: `target species "${s}" — ${ok.reason}; dropped` });
    }
    if (kept.length) {
      record.targetSpecies = kept;
      quotes.targetSpecies = keptQuotes;
    }
  }
  const safety = [];
  const safetyQuotes = [];
  for (const e of raw?.userSafety || []) {
    const v = verifyScalar(block, "userSafety", e, flags);
    if (v) {
      safety.push(v.value);
      safetyQuotes.push(v.quote);
    }
  }
  if (safety.length) {
    record.userSafety = safety;
    quotes.userSafety = safetyQuotes;
  }

  // composition: the basis by code, rows verified one by one
  const basis = basisOf(block);
  if (basis) {
    record.compositionBasis = basis.line;
    quotes.compositionBasis = { quote: basis.line, start: basis.start, end: basis.end };
  }
  const ings = [];
  const ingQuotes = [];
  for (const ing of raw?.activeIngredients || []) {
    const v = verifyIngredient(block, ing, { basis, convention }, flags);
    if (v) {
      ings.push(v.item);
      ingQuotes.push(v.quote);
    }
  }
  if (ings.length) {
    record.activeIngredients = ings;
    quotes.activeIngredients = ingQuotes;
  }

  // specifications: only a real SPECIFICATIONS table, read by code
  const rows = specRows(block);
  if (rows.length) {
    record.specifications = rows.map((r) => ({ item: r.item, specRaw: r.value }));
    quotes.specifications = rows.map((r) => ({ quote: r.quote, start: r.start, end: r.end }));
  }
  const categoryProposal = raw?.categoryProposal ? String(raw.categoryProposal).trim().slice(0, 80) : null;
  return { isProduct: raw?.isProduct !== false, record, quotes, flags, categoryProposal };
}

/** Re-reads every stored amount with a new convention (the admin's), from amountRaw — no AI. */
export function renormalise(extracted, block, convention) {
  const record = { ...(extracted?.record || {}) };
  const basis = basisOf(block);
  const keep = (extracted?.flags || []).filter((f) => !(f.field === "activeIngredients" && ["ambiguous_number", "amount_exceeds_basis", "unreadable_number"].includes(f.code)));
  const flags = [...keep];
  record.activeIngredients = (record.activeIngredients || []).map((ing) => {
    if (!ing.amountRaw) return ing;
    const n = normaliseAmount(ing.amountRaw, { basis, convention });
    for (const f of n.flags) flags.push({ ...f, field: "activeIngredients", ingredient: ing.name, message: `"${ing.name}": ${f.message}` });
    const { readAs: _drop, ...rest } = ing;
    return { ...rest, amount: n.amount, unit: n.unit, ...(n.readAs ? { readAs: n.readAs } : {}) };
  });
  return { ...extracted, record, flags };
}
