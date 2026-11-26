import { compositionFrom } from "../intake/intakeRules.js";
import { countryIn } from "../assistant/countries.js";
import { displayPack } from "../certificates/matching/packNormalizer.js";

// Harvest (28 Nov): every useful value a page of a file prints, by code, each with its evidence
// (page + the snippet it was read from). The person must never type what a file already says.
//   product   — name, category, form, pack, validity, origin, storage, composition (+ basis),
//               indications, dosage, withdrawal, target species, specifications, appearance
//   company   — producer name, registration no, address, country, email, website, phone
//   document  — document number (its numbering pattern), issue date (its date format)
//   batch     — batch / lot no, batch size, production / expiry dates, analysis results: per_batch,
//               and only from a certificate of analysis, a lab report or a manufacturing order
//               (a label's printed batch is its print run's, never harvested)
// Pure: harvestService.js stores the facts and merges them.

const clean = (s) => String(s || "").replace(/\s+/g, " ").replace(/^[\s:;,.•|–—-]+|[\s;,•|–—-]+$/g, "").trim();
export const norm = (v) => String(typeof v === "string" ? v : JSON.stringify(v) || "").toLowerCase().replace(/[^a-z0-9؀-ۿ%.]+/g, "");
/** "100ML" / "100 mL" / "100ml" → "100 mL"; "1 L" → "1 L" */
// Phase 4: the shared pack normalizer ("100ML" = "100 mL", "1 Ltr" = "1 L", Arabic digits and units)
export const normPack = (s) => displayPack(s);

// [regex (the label), entity, key, how the value is taken]
const FIELDS = [
  [/\b(?:Trade|Product)\s+Name\s*:/gi, "product", "name", "short"],
  [/\bCategory\s*:/gi, "product", "category", "short"],
  [/\b(?:Product|Dosage)\s+Form\s*:/gi, "product", "physicalForm", "short"],
  [/\b(?:Package|Packing|Pack)\s+Size\s*:/gi, "product", "packaging", "pack"],
  [/\b(?:Validity|Shelf\s+Life)\s*:/gi, "product", "validity", "sentence"],
  [/\b(?:Country\s+of\s+)?Origin\s*:/gi, "product", "origin", "country"],
  [/\bStorage(?:\s+Conditions?)?\s*:/gi, "product", "storage", "sentence"],
  [/\b(?:Produced|Manufactured)\s+by\s*:/gi, "company", "producerName", "company"],
  [/\b(?:Document|Certificate|Report)\s*(?:#|No\.?|Number)\s*:/gi, "document", "documentNo", "code"],
  [/\b(?:Issue\s+Date|Date\s+of\s+(?:Issue|Certificate))\s*:/gi, "document", "issueDate", "date"],
  [/\b(?:Batch|Lot)\s*(?:No\.?|Number|#)\s*:/gi, "batch", "batchNo", "code"],
  [/\bBatch\s+Size\s*:/gi, "batch", "batchSize", "qty"],
  [/\b(?:Production|Pro\.|Mfg\.?|Manufacturing)\s*Date\s*:/gi, "batch", "productionDate", "date"],
  [/\b(?:Expiry|Exp\.|Expiration)\s*Date\s*:/gi, "batch", "expiryDate", "date"],
];
// section headers (labels print them in capitals, no colon): the text up to the next header
const SECTIONS = [
  [/\bINDICATIONS?\b:?/g, "indications"],
  [/\bDOSAGE(?:\s+AND\s+ADMINISTRATION)?\b:?/g, "dosage"],
  [/\bWITHDRAWAL\s+(?:TIMES?|PERIODS?)\b:?/g, "withdrawalPeriod"],
  [/\bTARGET\s+(?:SPECIES|ANIMALS)\b:?/g, "targetSpecies"],
  [/\bCONTRA-?\s?INDICATIONS?\b:?/g, "contraindications"],
  [/\bSTORAGE\b:?/g, "storage"],
];
const STOP = /\b(?:INDICATIONS?|DOSAGE|WITHDRAWAL|TARGET\s+SPECIES|CONTRA-?INDICATIONS?|COMPOSITION|STORAGE|Batch\s+No|Produced\s+by|FOR\s+ANIMAL\s+USE|CAUTIONS?!?|KEEP\s+OUT|For\s+more\s+information|www\.)/;
const DATE = /^(\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{2,4}|\d{1,2}\s*\/\s*\d{4}|\d{4}-\d{2}(?:-\d{2})?)/;
const RESULT_WORD = /\s((?:Conforms?|Complies|Positive|Negative|Pass(?:es)?|Absent|Present|Not\s+detected|-?\d+(?:[.,]\d+)?\s*(?:%|mg|g|IU|cfu)?))\s*$/i;
const TESTS = /\b(Constituents?(?:\s*\([^)]*\))?|Appearance|Identi(?:fi|ﬁ)cation|Description|Colou?r|Odou?r|Clarity|Solubility|pH|Sterility|Pyrogens?|Endotoxins?|Moisture|Water\s+content|Loss\s+on\s+drying|Density|Specific\s+gravity|Viscosity|Assay|Particle\s+size|Heavy\s+metals|Microbial\s+limits?)\b/g;

function take(how, raw) {
  const v = clean(raw);
  if (!v) return null;
  switch (how) {
    case "short":
      return clean(v.split(/\s+/).slice(0, 4).join(" ").replace(/\s+(?:Packing|Package|Origin|Category|Product|Batch|Analysis|Validity|Country|Produced|Document|Issue|Composition|Contains)\b.*$/i, "")) || null;
    case "pack": {
      const m = v.match(/^\d+(?:[.,]\d+)?\s*(?:ml|l|lt|ltr|g|gm|kg|mg)\b/i);
      return m ? normPack(m[0]) : null;
    }
    case "sentence":
      return clean(v.split(/(?<=\.)\s|\s(?=[A-Z][a-z]+\s*:)/)[0]).slice(0, 200) || null;
    case "country": {
      const c = countryIn(v.split(/\s+/).slice(0, 3).join(" "));
      return c ? { code: c, text: clean(v.split(/\s+/)[0]) } : null;
    }
    case "company":
      return clean(v.match(/^([A-Z][A-Za-z&.' -]{3,60}?(?:CO\.?|COMPANY|LTD\.?|LLC|S\.A\.E\.?|Inc\.?))/)?.[1] || v.split(/\s*[([|]/)[0].split(/\s+/).slice(0, 6).join(" ")) || null;
    case "code": {
      const m = v.match(/^([A-Z0-9][A-Z0-9/-]{3,30})\b/);
      return m && /\d/.test(m[1]) ? m[1] : null;
    }
    case "date":
      return v.match(DATE)?.[1]?.replace(/\s+/g, "") || null;
    case "qty":
      return v.match(/^[\d.,]+\s*(?:KG|kg|L|l|g|units?|pcs)\b/)?.[0] || null;
    default:
      return v.slice(0, 200);
  }
}

/** "COAAVVI0926001" → "COAAVVI{MM}{YY}{SEQ3}"-ish pattern and its prefix (document numbering) */
export function numberPattern(no, issueDate = null) {
  const m = String(no || "").match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  const digits = m[2];
  let mm = null;
  let yy = null;
  if (issueDate) {
    const d = String(issueDate).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (d) [mm, yy] = [d[2].padStart(2, "0"), d[3].slice(-2)];
  }
  // the month / year printed inside the number, in the forms seen: MMYY (COAAVVI0926…), YY0MM (COCAF26009…), YYMM
  const forms = mm ? [[mm + yy, "{MM}{YY}"], [yy + "0" + mm, "{YY}0{MM}"], [yy + mm, "{YY}{MM}"]] : [];
  for (const [lead, tpl] of forms) if (digits.startsWith(lead) && digits.length > lead.length) return { prefix: m[1], pattern: `${m[1]}${tpl}{SEQ${digits.length - lead.length}}`, seq: Number(digits.slice(lead.length)) };
  return { prefix: m[1], pattern: `${m[1]}{SEQ${digits.length}}`, seq: Number(digits) };
}
/** "23/9/2026" → "D/M/YYYY"; "23/09/2026" → "DD/MM/YYYY"; "10/2026" → "MM/YYYY" */
export const dateFormatOf = (s) => {
  const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[1].length === 2 ? "DD" : "D"}/${m[2].length === 2 ? "MM" : "M"}/YYYY`;
  return /^\d{1,2}\/\d{4}$/.test(String(s || "")) ? "MM/YYYY" : null;
};

/**
 * One page → facts. kind: certificate | label | lab | mo | registration | catalogue | other;
 * product: the product the page is about (from the drop), when known; knownProducts: names in the drop.
 * → [{ entity, key, value, productName?, pack?, snippet, perBatch, batchNo? }]
 */
export function harvestPage({ text, kind = "other", certCode = null, product = null, knownProducts = [] }) {
  const t = String(text || "").replace(/\s+/g, " ");
  const out = [];
  const snip = (i, len = 140) => t.slice(Math.max(0, i - 10), i + len).trim();
  const batchAllowed = (kind === "certificate" && certCode === "COA") || kind === "lab" || kind === "mo";
  // every labelled value, up to the next label
  const hits = [];
  for (const [re, entity, key, how] of FIELDS) for (const m of t.matchAll(re)) hits.push({ s: m.index, e: m.index + m[0].length, entity, key, how });
  hits.sort((a, b) => a.s - b.s);
  for (const [i, h] of hits.entries()) {
    const raw = t.slice(h.e, hits[i + 1]?.s ?? h.e + 220);
    const value = take(h.how, raw);
    if (!value) continue;
    if (h.entity === "batch" && !batchAllowed) continue; // a label's printed batch is its print run's
    out.push({ entity: h.entity, key: h.key, value, snippet: snip(h.s), perBatch: h.entity === "batch" });
  }
  // label / leaflet sections
  for (const [re, key] of SECTIONS)
    for (const m of t.matchAll(re)) {
      const rest = t.slice(m.index + m[0].length);
      const end = rest.search(STOP);
      const value = clean(rest.slice(0, end > 0 ? end : 600)).slice(0, 600);
      if (value.length >= 8) out.push({ entity: "product", key, value, snippet: snip(m.index, 200), perBatch: false });
    }
  // composition (a COC page, or a label's COMPOSITION section)
  const compText = /Composition\s*:/i.test(t) ? t : /\bCOMPOSITION\b/.test(t) ? t.replace(/\bCOMPOSITION\b\s*/, "Composition: ").replace(/\s(?:INDICATIONS?|DOSAGE|FOR ANIMAL USE|WITHDRAWAL)\b.*$/, "") : null;
  const comp = compText ? compositionFrom(compText) : null;
  if (comp?.ingredients?.length) {
    out.push({ entity: "product", key: "activeIngredients", value: comp.ingredients, snippet: comp.quote?.slice(0, 200) || null, perBatch: false });
    if (comp.basis) out.push({ entity: "product", key: "compositionBasis", value: comp.basis, snippet: comp.quote?.slice(0, 80) || null, perBatch: false });
  }
  // company: registration no, address, contacts
  const reg = t.match(/([A-Z][A-Za-z&.' -]{3,60}?(?:CO\.?|COMPANY|LTD\.?))\s*[([]Registration\s+No:?\s*(\d+)[)\]]/);
  if (reg) {
    out.push({ entity: "company", key: "producerName", value: clean(reg[1]), snippet: reg[0], perBatch: false });
    out.push({ entity: "company", key: "registrationNo", value: reg[2], snippet: reg[0], perBatch: false });
    const addr = t.slice(t.indexOf(reg[0]) + reg[0].length).split(/\s(?:For\s+more|www\.|Notes:|\+\d|Tel|E-?mail)/i)[0];
    const a = clean(addr);
    if (a.length >= 8 && a.length <= 120 && countryIn(a)) out.push({ entity: "company", key: "address", value: a, snippet: a, perBatch: false });
    if (a && countryIn(a)) out.push({ entity: "company", key: "country", value: countryIn(a), snippet: a, perBatch: false });
  }
  const email = t.match(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/);
  if (email) out.push({ entity: "company", key: "email", value: email[0].toLowerCase(), snippet: email[0], perBatch: false });
  const web = t.match(/\bwww\.[\w-]+\.[\w.]+/i);
  if (web) out.push({ entity: "company", key: "website", value: web[0].toLowerCase(), snippet: web[0], perBatch: false });
  const phone = t.match(/(?:Tel:?\s*)?(\+\d[\d\s]{7,16}\d)/);
  if (phone) out.push({ entity: "company", key: "phone", value: phone[1].replace(/\s+/g, " "), snippet: phone[0], perBatch: false });
  const producer = t.match(/\bProducer\s+([A-Z][A-Za-z ]{3,60}?(?:Company|CO\.?|LTD\.?))\b/);
  if (producer) out.push({ entity: "company", key: "producerName", value: clean(producer[1]), snippet: producer[0], perBatch: false });
  // a COA's analysis table: each test's specification (descriptive) and, per batch, its result
  const table = t.match(/\b(?:Analysis\s+)?Speci(?:fi|ﬁ)cations\s+Results\b(.+?)(?=\bProducer\b|\*\s*We\s+certify|$)/i);
  if (table && certCode === "COA") {
    const rows = [];
    const body = table[1];
    const marks = [...body.matchAll(TESTS)];
    marks.forEach((m, k) => rows.push({ test: m[1], text: body.slice(m.index + m[0].length, marks[k + 1]?.index ?? body.length).trim() }));
    for (const r of rows) {
      if (/^Constituents?/i.test(r.test)) continue;
      const res = r.text.match(RESULT_WORD);
      const spec = clean(res ? r.text.slice(0, res.index) : r.text);
      const test = r.test.replace(/ﬁ/g, "fi");
      if (spec) out.push({ entity: "product", key: `spec:${test}`, value: spec, snippet: `${r.test} ${r.text}`.slice(0, 160), perBatch: false });
      if (/^Appearance$/i.test(test) && spec) out.push({ entity: "product", key: "appearance", value: spec, snippet: `${r.test} ${spec}`, perBatch: false });
      if (res) out.push({ entity: "batch", key: `result:${test}`, value: clean(res[1]), snippet: `${r.test} ${r.text}`.slice(0, 160), perBatch: true });
    }
  }
  // an HC / FSC "attached list" printed column by column: names, brands, descriptions, packs, forms
  if (/ATTACHED\s+LIST|PRODUCT\s+NAME\s+BRAND/i.test(t) && knownProducts.length >= 2) {
    const up = t.toUpperCase().replace(/\*/g, "");
    const at = knownProducts.map((n) => ({ n, i: up.indexOf(String(n).toUpperCase()) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);
    if (at.length >= 2) {
      const last = at[at.length - 1];
      const tail = up.slice(last.i + String(last.n).length).trim().split(/\s+/);
      const N = at.length;
      const brands = tail.slice(0, N);
      const descs = tail.slice(N, 2 * N);
      const packsTxt = tail.slice(2 * N).join(" ");
      const packs = [...packsTxt.matchAll(/\d+(?:[.,]\d+)?\s*(?:ML|L|G|KG|GM)\b/g)].slice(0, N).map((m) => normPack(m[0]));
      const afterPacks = packs.length === N ? packsTxt.slice([...packsTxt.matchAll(/\d+(?:[.,]\d+)?\s*(?:ML|L|G|KG|GM)\b/g)][N - 1].index).split(/\s+/).slice(2, 2 + N) : [];
      at.forEach(({ n }, k) => {
        const s = `${n}: ${[brands[k], descs[k], packs[k], afterPacks[k]].filter(Boolean).join(" · ")}`;
        if (descs[k] && descs.length === N) out.push({ entity: "product", productName: n, key: "category", value: descs[k], snippet: s, perBatch: false });
        if (packs[k] && packs.length === N) out.push({ entity: "product", productName: n, key: "packaging", value: packs[k], snippet: s, perBatch: false });
        if (afterPacks[k] && afterPacks.length === N && /^[A-Z]{3,}$/.test(afterPacks[k])) out.push({ entity: "product", productName: n, key: "physicalForm", value: afterPacks[k], snippet: s, perBatch: false });
      });
    }
  }
  // document numbering + date format (never printed as a value: used to make NEW numbers)
  const no = out.find((f) => f.key === "documentNo");
  const date = out.find((f) => f.key === "issueDate");
  if (no) {
    const p = numberPattern(no.value, date?.value);
    if (p) out.push({ entity: "document", key: "numbering", value: { certCode, ...p }, snippet: no.snippet, perBatch: false });
  }
  if (date && dateFormatOf(date.value)) out.push({ entity: "document", key: "dateFormat", value: dateFormatOf(date.value), snippet: date.snippet, perBatch: false });
  // a document's own number / date are that document's — never a product's value
  const pageProduct = out.find((f) => f.entity === "product" && f.key === "name")?.value || product || null;
  const batchNo = out.find((f) => f.key === "batchNo")?.value || null;
  const pack = out.find((f) => f.key === "packaging" && !f.productName)?.value || null;
  return out
    .filter((f) => !["documentNo", "issueDate"].includes(f.key))
    .map((f) => ({ ...f, productName: f.productName || (f.entity === "product" || f.entity === "batch" ? pageProduct : null), pack: f.entity === "product" || f.entity === "batch" ? pack : null, batchNo: f.perBatch ? batchNo : null, certCode }));
}
