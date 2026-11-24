// What a dropped file is, from its name and its text layer — no AI, no database.
// The intake classifier (intakeService) runs these first; the AI is asked only
// when they don't decide. Every conclusion carries its evidence (the filename
// token, the text it read, the page).
//
// Hard limit: batch numbers, production / expiry dates and lab results are only
// ever READ — the value printed next to its label on a page. Nothing here guesses
// one; a label with no value next to it stays empty.

export const DOC_TYPES = ["label", "certificate_template", "certificate_filled", "invoice", "manufacturing_order", "catalogue", "product_list", "other"];

// certificate titles → the certificate type code
export const CERT_TITLES = [
  [/certificate\s+of\s+analysis|\bte of analysis\b/i, "COA"],
  [/certificate\s+of\s+composition/i, "COC"],
  [/certificate\s+of\s+conformity/i, "COC"],
  [/certificate\s+of\s+origin/i, "COO"],
  [/health\s+certificate/i, "HC"],
  [/free\s+sale\s+certificate/i, "FSC"],
  [/\bGMP\s+certificate|good\s+manufacturing\s+practice/i, "GMP"],
];
const CERT_CODES = new Set(["COA", "COC", "COO", "HC", "FSC", "GMP"]);

export const COUNTRIES = {
  OMAN: "OM", KSA: "SA", SAUDI: "SA", UAE: "AE", EMIRATES: "AE", EGYPT: "EG", JORDAN: "JO", IRAQ: "IQ", KUWAIT: "KW", QATAR: "QA", BAHRAIN: "BH",
  PAKISTAN: "PK", LIBYA: "LY", SUDAN: "SD", YEMEN: "YE", LEBANON: "LB", SYRIA: "SY", ALGERIA: "DZ", MOROCCO: "MA", TUNISIA: "TN", TURKEY: "TR",
};
const NOISE = new Set(["NEW", "COPY", "FINAL", "LABEL", "LABELS", "DESIGN", "V1", "V2", "V3", "PRINT", "OUTLINE", "OUTLINED", "AI", "PDF"]);
const VOLUME = /(?:^|[\s_-])(\d+(?:[.,]\d+)?)\s*(ML|L|LT|LTR|LITRE|LITER|KG|G|GM|GR)(?=$|[\s_.-])/i;
const SIZE_MM = /(\d{2,3})\s*[x×]\s*(\d{2,3})\s*mm/i;

const ext = (name) => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
const base = (name) => String(name).replace(/\.[a-z0-9]+$/i, "");
/** "C A T A L O G U E" → "CATALOGUE": letters a design spaced out read as a word */
const unspace = (t) => String(t || "").replace(/\b(?:[A-Za-z] ){3,}[A-Za-z]\b/g, (m) => m.replace(/ /g, ""));
const digits = (s) => String(s || "").replace(/(\d)\s+(?=[\d/])/g, "$1").replace(/\/\s+(?=\d)/g, "/");

/**
 * The file name alone → { ext, tokens, certCode, country, volume, sizeMm, productName, documentNo, catalogue, invoiceWord, evidence[] }
 * "40 - ADDMECTIN 1% _100ML.pdf" → productName "ADDMECTIN 1%", volume "100ML"
 */
export function fromFilename(name, { companyNames = [] } = {}) {
  const b = base(name);
  const evidence = [];
  const tokens = b.toUpperCase().split(/[^A-Z0-9%]+/).filter(Boolean);
  const out = { ext: ext(name), tokens, certCode: null, country: null, volume: null, sizeMm: null, productName: null, documentNo: null, catalogue: false, invoiceWord: false, companyTokens: [], evidence };
  for (const t of tokens) {
    if (CERT_CODES.has(t) && !out.certCode) {
      out.certCode = t;
      evidence.push({ from: "filename", text: t, says: `certificate ${t}` });
    } else if (/^(FSC|COA|COC|COO|HC)[A-Z]{0,6}\d/.test(t) && !out.certCode) {
      out.certCode = t.match(/^(FSC|COA|COC|COO|HC)/)[1];
      out.documentNo = t;
      evidence.push({ from: "filename", text: t, says: `certificate number (${out.certCode})` });
    }
    if (COUNTRIES[t] && !out.country) {
      out.country = COUNTRIES[t];
      evidence.push({ from: "filename", text: t, says: `country ${out.country}` });
    }
  }
  if (/catalog(ue)?/i.test(b)) {
    out.catalogue = true;
    evidence.push({ from: "filename", text: "catalogue", says: "catalogue" });
  }
  if (/\b(invoice|inv|proforma)\b/i.test(b)) {
    out.invoiceWord = true;
    evidence.push({ from: "filename", text: "invoice", says: "invoice" });
  }
  const doc = tokens.find((t) => /^[A-Z]{3,8}\d{6,}$/.test(t) && !CERT_CODES.has(t.slice(0, 3)));
  if (doc && !out.documentNo) {
    out.documentNo = doc;
    evidence.push({ from: "filename", text: doc, says: "document number" });
  }
  const vol = b.match(VOLUME);
  if (vol) {
    out.volume = `${vol[1].replace(",", ".")}${vol[2].toUpperCase().replace(/^(LT|LTR|LITRE|LITER)$/, "L").replace(/^(GM|GR)$/, "G")}`;
    evidence.push({ from: "filename", text: vol[0].trim(), says: `pack size ${out.volume}` });
  }
  const size = b.match(SIZE_MM);
  if (size) out.sizeMm = { widthMm: Number(size[1]), heightMm: Number(size[2]) };
  const known = companyNames.map((n) => String(n).toUpperCase().replace(/[^A-Z0-9]/g, "")).filter((n) => n.length >= 3);
  out.companyTokens = tokens.filter((t) => known.includes(t));
  // the product: what is left once numbering, sizes, codes, countries and noise are gone
  if (!out.catalogue && !out.certCode && !out.documentNo) {
    const name2 = b
      .replace(/^\s*\d{1,3}\s*[-_.)]*\s*/, "")
      .replace(VOLUME, " ")
      .replace(SIZE_MM, " ")
      .replace(/[_]+/g, " ")
      .split(/\s+/)
      .filter((w) => w && !NOISE.has(w.toUpperCase()) && !COUNTRIES[w.toUpperCase()] && !known.includes(w.toUpperCase().replace(/[^A-Z0-9]/g, "")))
      .join(" ")
      .replace(/\s+-\s*$/, "")
      .trim();
    if (name2 && /[A-Za-z]{3,}/.test(name2)) {
      out.productName = name2.toUpperCase();
      evidence.push({ from: "filename", text: name2, says: `product ${out.productName}` });
    }
  }
  return out;
}

/** "Batch No.: MADADD02610001" … on one page → [{ batchNo, productionDate, expiryDate, page }] — only values printed next to their label */
export function batchFacts(text, page) {
  const t = digits(text);
  // a batch number has a digit: "BATCH NO. NOTES" (a table header) is no batch
  const batchNo = t.match(/batch\s*(?:no\.?|number|#)\s*[:.]?\s*((?=[A-Z0-9/-]*\d)[A-Z0-9][A-Z0-9/-]{3,})/i)?.[1] || null;
  const date = (re) => t.match(re)?.[1] || null;
  const productionDate = date(/(?:pro(?:d(?:uction)?)?\.?|mfg\.?|manufactur(?:ing|e)?)\s*date\s*[:.]?\s*(\d{1,2}[/.-]\d{2,4}(?:[/.-]\d{2,4})?)/i);
  const expiryDate = date(/(?:exp(?:iry)?\.?|expiration)\s*date\s*[:.]?\s*(\d{1,2}[/.-]\d{2,4}(?:[/.-]\d{2,4})?)/i);
  if (!batchNo && !productionDate && !expiryDate) return null;
  return { batchNo, productionDate, expiryDate, page };
}

/** The issuer / company named in a document's text → [{ name, says }] best first. */
export function companiesInText(text) {
  const t = unspace(text);
  const found = [];
  const add = (name, says) => {
    const n = String(name || "").trim().replace(/[.,;:]+$/, "");
    if (n.length >= 3 && !found.some((f) => f.name.toUpperCase() === n.toUpperCase())) found.push({ name: n, says });
  };
  for (const m of t.matchAll(/\b(?:www\.|info@|@)?([a-z0-9-]{3,30})\.(?:net|com|org|co|jo|eg|sa)\b/gi)) if (!/^(gmail|gamil|yahoo|hotmail|outlook)$/i.test(m[1])) add(m[1].toUpperCase(), `web address ${m[0]}`);
  // the brand word right before "ANIMAL HEALTH" ("WELCOME TO ADDVET ANIMAL HEALTH" → ADDVET)
  for (const m of t.matchAll(/\b([A-Z][A-Z&'-]{2,30})\s+ANIMAL\s+HEALTH\b/g)) if (!/^(THE|TO|AND|FOR|OF|IN)$/.test(m[1])) add(m[1], `"${m[0].trim()}"`);
  for (const m of t.matchAll(/(?:produced|manufactured)\s+by\s*:?\s*([A-Z][A-Za-z&.' -]{3,40}?(?:CO\.?|COMPANY|LTD\.?|LLC|S\.A\.E\.?))/gi)) add(m[1], `"${m[0].trim()}"`);
  return found;
}

/** Product names a certificate page states ("Product Name: ADDMECTIN 1% Category") → [name] */
export function productsInText(text) {
  const names = [];
  for (const m of String(text || "").matchAll(/(?:product\s+name|trade\s+name)\s*:\s*([A-Z0-9][A-Z0-9 %+.-]{2,40}?)\s+(?=Category|Composition|Batch|Packing|Package|Form|Origin|$)/gi)) {
    const n = m[1].trim().toUpperCase();
    if (!names.includes(n)) names.push(n);
  }
  return names;
}

const LABEL_SIGNS = [/\bcomposition\b/i, /\bindications?\b/i, /for\s+animal\s+use\s+only/i, /each\s+1\s*(?:litre|liter|l|ml|kg|g)\s+contains/i, /contains\s+per\s+(?:ml|g|kg)/i, /\bdosage\b/i, /withdrawal/i, /oral\s+(?:liquid|powder|solution)/i, /\bnutrition\s+facts\b/i, /\bbenefits\b/i, /\bstorage\b/i];

/**
 * One document's pages → what the text says it is.
 * → { docType?, certCode?, filled, signals: {…}, evidence[], products[], batches[], companies[], language }
 */
export function fromText(pages = []) {
  const all = pages.map((p) => p.text).join("\n");
  const first = unspace(pages.slice(0, 2).map((p) => p.text).join(" "));
  const evidence = [];
  const out = { docType: null, certCode: null, filled: false, evidence, products: [], batches: [], companies: companiesInText(all), language: languageOf(all), signals: {} };
  if (!all.trim()) {
    out.signals.noText = true;
    return out;
  }
  const say = (re, says, page = 1) => {
    const m = first.match(re);
    if (m) evidence.push({ from: "text", page, text: m[0].slice(0, 60), says });
    return !!m;
  };
  if (say(/\bmanufacturing\s+order\b/i, "manufacturing order")) out.docType = "manufacturing_order";
  else if (say(/\b(?:tax\s+)?invoice\b(?=[\s#:]|$)(?!\s+ref)/i, "invoice") && /invoice\s*(?:#|no\.?|number)\s*:?\s*\S+/i.test(first)) out.docType = "invoice";
  else if (say(/\bcatalogue?\b|\bcatalog\b/i, "catalogue") && pages.length >= 4) out.docType = "catalogue";
  for (const [re, code] of CERT_TITLES) {
    if (!out.docType && re.test(first)) {
      out.certCode = code;
      evidence.push({ from: "text", page: 1, text: first.match(re)[0], says: `certificate ${code}` });
      break;
    }
  }
  if (out.certCode) {
    // issued (filled): a certificate / document number, batch facts or results on it
    const issued = [/certificate\s*no\.?\s*:?\s*[A-Z0-9-]{4,}/i, /document\s*#\s*:?\s*[A-Z0-9-]{4,}/i, /batch\s*no\.?\s*:?\s*[A-Z0-9-]{5,}/i, /\bresults?\b/i, /date\s+of\s+certificate\s*:?\s*\d/i, /\bdate\s*:\s*\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/i];
    const hits = issued.filter((re) => re.test(all));
    out.filled = hits.length > 0;
    if (out.filled) evidence.push({ from: "text", page: 1, text: all.match(hits[0])[0].slice(0, 60), says: "issued: has a number / batch / results" });
  }
  const labelHits = LABEL_SIGNS.filter((re) => re.test(all)).length;
  out.signals.labelHits = labelHits;
  if (!out.docType && !out.certCode && labelHits >= 2 && pages.length <= 3) {
    out.docType = "label";
    evidence.push({ from: "text", page: 1, text: LABEL_SIGNS.map((re) => all.match(re)?.[0]).filter(Boolean).slice(0, 3).join(" · "), says: "label wording (composition, indications…)" });
  }
  for (const p of pages) {
    for (const n of productsInText(p.text)) if (!out.products.some((x) => x.name === n)) out.products.push({ name: n, page: p.n });
    const b = batchFacts(p.text, p.n);
    if (b) out.batches.push(b);
  }
  return out;
}

export function languageOf(text) {
  const t = String(text || "");
  const ar = (t.match(/[؀-ۿ]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (!ar && !latin) return null;
  if (ar > latin * 2) return "ar";
  if (latin > ar * 2) return "en";
  return "ar+en";
}

/**
 * A certificate bundle: several certificates of one type, one per page (each page
 * names its own product). → [{ from, to, product, batch }] when it splits, else null.
 */
export function splitBundle(pages, certCode) {
  if (pages.length < 2 || !certCode) return null;
  const titled = pages.filter((p) => CERT_TITLES.some(([re, code]) => code === certCode && re.test(p.text))).length;
  if (titled < pages.length * 0.6) return null; // a certificate with an attached list (HC page 2) is one document
  const parts = pages.map((p) => ({ from: p.n, to: p.n, product: productsInText(p.text)[0] || null, batch: batchFacts(p.text, p.n) }));
  const named = new Set(parts.map((x) => x.product).filter(Boolean));
  return named.size >= 2 ? parts : null;
}

/**
 * Filename + text → the rules' verdict for one file.
 * → { docType, certCode, role, confidence, evidence, productNames, country, volume, language, filled, batches, companies, documentNo, parts, question }
 */
export function classify({ name, pages = [], pageCount = pages.length, companyNames = [] }) {
  const f = fromFilename(name, { companyNames });
  const t = fromText(pages);
  const evidence = [...f.evidence, ...t.evidence];
  const r = { docType: "other", certCode: t.certCode || f.certCode, role: null, confidence: 0.3, evidence, productNames: [], country: f.country, volume: f.volume, sizeMm: f.sizeMm, language: t.language, filled: t.filled, batches: t.batches, companies: t.companies, documentNo: f.documentNo, parts: null, question: null, ext: f.ext, pageCount };
  if (["xlsx", "csv"].includes(f.ext)) return { ...r, docType: "product_list", confidence: 0.9, evidence: [...evidence, { from: "filename", text: f.ext, says: "spreadsheet" }] };
  if (f.ext === "html" || f.ext === "htm") return { ...r, docType: "certificate_template", confidence: r.certCode ? 0.85 : 0.5, question: r.certCode ? null : "certificate_type" };
  const isAi = f.ext === "ai";
  if (t.docType === "manufacturing_order" || t.docType === "invoice") {
    r.docType = t.docType;
    r.confidence = f.documentNo ? 0.97 : 0.9;
  } else if (t.docType === "catalogue" || (f.catalogue && pageCount >= 4)) {
    r.docType = "catalogue";
    r.confidence = t.docType === "catalogue" && f.catalogue ? 0.98 : 0.85;
  } else if (r.certCode) {
    // an .ai design is the company's template; an issued PDF (numbers, batches, results) is filled
    if (isAi) {
      r.docType = "certificate_template";
      r.confidence = t.certCode && f.certCode ? 0.95 : 0.8;
      evidence.push({ from: "filename", text: ".ai", says: "a design file: the template" });
    } else if (t.filled) {
      r.docType = "certificate_filled";
      r.confidence = t.certCode ? 0.92 : 0.7;
    } else {
      r.docType = "certificate_template";
      r.confidence = t.certCode ? 0.85 : 0.6;
    }
    // a bundle of issued certificates splits into one item per certificate; a template is one design (its first page)
    r.parts = r.docType === "certificate_filled" ? splitBundle(pages, r.certCode) : null;
    r.productNames = [...new Set(t.products.map((p) => p.name))];
  } else if (t.docType === "label" || (f.volume && f.productName && !t.signals.noText) || (isAi && f.productName && t.signals.labelHits >= 1)) {
    r.docType = "label";
    r.confidence = t.docType === "label" ? (f.productName ? 0.93 : 0.8) : 0.65;
    if (t.docType !== "label") evidence.push({ from: "filename", text: f.productName, says: "a product name with a pack size: a label" });
  } else if (t.signals.noText) {
    r.confidence = 0.2;
    r.question = "doc_type";
  }
  if (r.docType === "label") {
    // the label's own product: the filename's, checked against the text when the text has it
    const text = pages.map((p) => p.text).join(" ").toUpperCase();
    if (f.productName) {
      r.productNames = [f.productName];
      const core = f.productName.replace(/[^A-Z0-9]/g, "");
      if (core && text.replace(/[^A-Z0-9]/g, "").includes(core)) evidence.push({ from: "text", page: 1, text: f.productName, says: "the product name is printed on the label" });
      else r.confidence = Math.min(r.confidence, 0.75);
    }
    if (isAi) r.role = "design_source";
  }
  if (r.docType === "certificate_filled" && !r.parts && r.batches.length === 0 && ["FSC", "HC", "COO", "COC"].includes(r.certCode)) r.role = "issued_document";
  if (r.confidence < 0.6 && !r.question) r.question = "doc_type";
  return r;
}
