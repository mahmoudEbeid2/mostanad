import { prisma } from "../../lib/prisma.js";
import { countryIn } from "../assistant/countries.js";
import { brandScore, brandKey } from "../brandMatch.js";

// Whose is each file, and what will happen to it. Works on the whole drop at once:
// a label that names no company takes the company the other files name ("ADDVET"
// on the certificates and catalogues), a label's .ai and .pdf are one label, one
// certificate type gets one template. Nothing is written here except the items'
// proposals; companies, brands and products are only PROPOSED ("new: ADDVET").

const norm = (s) => brandKey(s);
const nameScore = (a, b) => brandScore(a, b) || (norm(a) && norm(a) === norm(b) ? 1 : 0);
const base = (n) => String(n || "").replace(/\.[a-z0-9]+$/i, "").trim().toLowerCase();

/** The companies / brands / products a drop can be matched against, within the caller's scope. */
export async function loadScope({ companyId = null }) {
  const companies = await prisma.company.findMany({ where: companyId ? { id: companyId } : {}, select: { id: true, name: true } });
  const brands = await prisma.brand.findMany({ where: companyId ? { companyId } : {}, select: { id: true, name: true, companyId: true } });
  const products = await prisma.product.findMany({ where: companyId ? { companyId } : {}, select: { id: true, name: true, productCode: true, brandId: true, companyId: true, packaging: true }, take: 20000 });
  return { companies, brands, products };
}

/** "ADDVET" → the existing company it names (its own name, or one of its brands), or null. */
function matchCompany(scope, name) {
  if (!name) return null;
  let best = null;
  for (const c of scope.companies) {
    const s = nameScore(name, c.name);
    if (s >= 0.8 && (!best || s > best.score)) best = { id: c.id, name: c.name, score: s, via: "company" };
  }
  for (const b of scope.brands) {
    const s = nameScore(name, b.name);
    if (s >= 0.8 && (!best || s > best.score)) best = { id: b.companyId, name: scope.companies.find((c) => c.id === b.companyId)?.name || name, score: s, via: `brand ${b.name}`, brand: b };
  }
  return best;
}

function matchProduct(scope, companyId, name) {
  if (!name || !companyId) return null;
  let best = null;
  for (const p of scope.products) {
    if (p.companyId !== companyId) continue;
    const s = Math.max(nameScore(name, p.name), p.productCode ? nameScore(name, p.productCode) : 0);
    if (s >= 0.8 && (!best || s > best.score)) best = { id: p.id, name: p.name, score: s };
  }
  return best;
}

const majority = (values) => {
  const counts = new Map();
  for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
};

export const ACTIONS = {
  label: { ar: "يتسجل كليبل مرجعي", en: "Saved as a reference label" },
  label_design: { ar: "يتحفظ كملف التصميم للّيبل", en: "Kept as the label's design file" },
  certificate_template: { ar: "يتعمل منه قالب شهادة (مسودة، تراجع حقوله)", en: "Becomes a certificate template (draft, fields to check)" },
  certificate_filled: { ar: "يتحفظ كإثبات للتشغيلة، وتتقري نتايجه", en: "Kept as evidence for the batch; its results are read" },
  certificate_both: { ar: "يتعمل منه قالب، ويتحفظ كإثبات", en: "Becomes a template, and is kept as evidence" },
  issued_document: { ar: "يتحفظ كشهادة صادرة للمنتجات", en: "Kept as an issued certificate of the products" },
  bundle: { ar: "يتقسم لشهادة لكل منتج", en: "Split into one certificate per product" },
  bundle_template: { ar: "يتقسم لشهادة لكل منتج، وأول صفحة يتعمل منها قالب", en: "Split into one certificate per product; its first page becomes the template" },
  invoice: { ar: "تتقري الفاتورة وتتطابق السطور", en: "The invoice is read and its lines matched" },
  manufacturing_order: { ar: "يتقري أمر التصنيع زي الفاتورة", en: "Read like an invoice (manufacturing order)" },
  catalogue: { ar: "يترفع ككتالوج (تختار صفحاته)", en: "Uploaded as a catalogue (pick its pages)" },
  product_list: { ar: "تتضاف/تتحدث المنتجات اللي فيه", en: "Its products are added / updated" },
  other: { ar: "يتحفظ بس (مش عارفين نوعه)", en: "Only kept (type not recognised)" },
  duplicate: { ar: "متكرر — اترفع قبل كده، مش هيترفع تاني", en: "Duplicate — already uploaded, skipped" },
  skip: { ar: "مش هيتعمل بيه حاجة", en: "Nothing will be done with it" },
};

/**
 * The proposals for every item of a drop. items: [{ id, name, sha256, parentId, classification }]
 * → Map(itemId → proposal { company, brand, products, country, action, docType, certCode, role, confidence, question, duplicateOf? })
 * company / brand: { id } (existing) | { name, isNew: true } | null; products: [{ id, name } | { name, volume, isNew }]
 */
export async function resolveDrop({ items, scope, sessionCompanyId = null, hintCompanyId = null, existingHashes = new Map(), newCompanyName = null }) {
  const leaf = items.filter((i) => i.classification && !i.classification.expanded);
  // the company the drop as a whole names
  const fixed = sessionCompanyId || hintCompanyId || null;
  const mentioned = leaf.flatMap((i) => [...(i.classification.companies || []).map((c) => c.name), ...(i.classification.companyTokens || [])]);
  const matched = mentioned.map((n) => matchCompany(scope, n)).filter(Boolean);
  const dropCompanyId = fixed || majority(matched.map((m) => m.id));
  const dropCompanyName = dropCompanyId ? scope.companies.find((c) => c.id === dropCompanyId)?.name : majority(mentioned.map((n) => String(n).toUpperCase()));
  // every row's own country (26 Nov: whole files showed "—" while their pages said عُمان): what the
  // file says, else its name ("ADDVET OMAN COA 10-26.pdf"), else what its pages say
  const ownCountry = new Map();
  for (const i of items.filter((x) => x.classification)) {
    const pages = items.filter((x) => x.parentId === i.id).map((x) => x.classification?.country || countryIn(x.classification?.pageText || "")).filter(Boolean);
    const fromName = countryIn(String(i.name || "").replace(/\.[a-z0-9]+$/i, "").replace(/ — .*$/, "").replace(/[_-]+/g, " "));
    const c = i.classification.country ? [i.classification.country, "file"] : fromName ? [fromName, "name"] : pages.length ? [majority(pages), "pages"] : null;
    if (c) ownCountry.set(i.id, c);
  }
  const dropCountry = majority(leaf.map((i) => ownCountry.get(i.id)?.[0]).filter(Boolean));
  // the person's «شركة جديدة: X» wins over any match (another company's brand named X included)
  const chosenNew = !fixed && newCompanyName ? { name: String(newCompanyName).trim(), isNew: true } : null;
  const company = chosenNew || (dropCompanyId ? { id: dropCompanyId, name: dropCompanyName } : dropCompanyName ? { name: dropCompanyName, isNew: true } : null);
  // the brand: an existing brand of that company the files name, else one named like the company
  const brandName = majority(mentioned.map((n) => String(n).toUpperCase())) || dropCompanyName;
  const companyBrands = scope.brands.filter((b) => b.companyId === company?.id);
  const brandHit = brandName ? companyBrands.map((b) => ({ b, s: nameScore(brandName, b.name) })).filter((x) => x.s >= 0.8).sort((x, y) => y.s - x.s)[0] : null;
  const brand = brandHit ? { id: brandHit.b.id, name: brandHit.b.name } : companyBrands.length === 1 && !brandName ? { id: companyBrands[0].id, name: companyBrands[0].name } : brandName ? { name: brandName, isNew: true } : null;

  // the products named across the drop, so a certificate's "SULFARIM" is the label's SULFAPRIM
  const dropProducts = [];
  for (const i of leaf) {
    for (const n of i.classification.productNames || []) {
      const hit = dropProducts.find((p) => nameScore(n, p.name) >= 0.8);
      if (hit) {
        if (i.classification.docType === "label") Object.assign(hit, { name: n, volume: i.classification.volume || hit.volume });
      } else dropProducts.push({ name: n, volume: i.classification.volume || null });
    }
  }
  const productFor = (n) => {
    const existing = matchProduct(scope, company?.id, n);
    if (existing) return { id: existing.id, name: existing.name };
    const drop = dropProducts.find((p) => nameScore(n, p.name) >= 0.8);
    return { name: drop?.name || n, volume: drop?.volume || null, isNew: true };
  };

  const pdfBases = new Set(leaf.filter((i) => i.classification.ext === "pdf").map((i) => base(i.name)));
  const templateFor = new Map(); // certCode → the item that becomes the template
  for (const i of leaf) if (i.classification.docType === "certificate_template" && !templateFor.has(i.classification.certCode)) templateFor.set(i.classification.certCode, i.id);
  const seen = new Map(); // sha256 → the first item with it

  const out = new Map();
  for (const i of items) {
    const c = i.classification;
    if (!c) continue;
    // a label / certificate without its own country takes the drop's; an invoice or catalogue never does (an invoice says its own destination)
    const inherits = ["label", "certificate_template", "certificate_filled"].includes(c.docType);
    const mine = ownCountry.get(i.id) || (i.parentId ? ownCountry.get(i.parentId) : null);
    const country = mine?.[0] || (inherits || c.expanded || c.parts?.length ? dropCountry : null) || null;
    const p = { docType: c.docType, certCode: c.certCode || null, role: c.role || null, confidence: c.confidence, question: c.question || null, company, brand, products: [], country, countryFrom: mine ? mine[1] : country ? "drop" : null, evidence: c.evidence || [] };
    if (!c.companies?.length && company) p.evidence = [...p.evidence, { from: "drop", says: `company ${company.name}: named by the other files in this drop` }];
    if (c.expanded) {
      out.set(i.id, { ...p, action: "skip", actionText: { ar: `اتفك (${c.expanded} ملف)`, en: `Unpacked (${c.expanded} files)` } });
      continue;
    }
    // the same file twice: in this company before, or twice in this drop
    const prior = i.sha256 && !i.parentId && company?.id ? existingHashes.get(`${company.id}|${i.sha256}`) : null;
    if (prior || (i.sha256 && seen.has(i.sha256) && !i.parentId)) {
      out.set(i.id, { ...p, action: "duplicate", duplicateOf: prior || { itemId: seen.get(i.sha256) }, actionText: ACTIONS.duplicate });
      continue;
    }
    if (i.sha256 && !i.parentId) seen.set(i.sha256, i.id);
    let names = [...new Set(c.productNames || [])];
    let readOnPage = false;
    // a certificate page whose "Product Name:" is empty: a product of this drop printed on the page
    if (!names.length && c.pageText) {
      const page = norm(c.pageText);
      const onPage = dropProducts.filter((d) => norm(d.name).length >= 4 && page.includes(norm(d.name)));
      if (onPage.length === 1) {
        names = [onPage[0].name];
        readOnPage = true;
        p.question = null;
        p.evidence = [...p.evidence, { from: "text", page: i.pageFrom || 1, says: `${onPage[0].name} is printed on the page (its "Product Name" is empty)` }];
      }
    }
    // a page whose product is unclear (none printed, or the same name on two pages): what the
    // SAME page of the drop's other bundles names — a suggestion for ONE short question, never applied.
    // Read from the page's own text, or the same name confirmed by the other file's page → settled.
    if (i.parentId && !readOnPage && (!names.length || c.question === "product")) {
      const parentPages = (id) => items.filter((x) => x.parentId === id).length;
      const mine = parentPages(i.parentId);
      const same = items.filter((x) => x.parentId && x.parentId !== i.parentId && x.pageFrom === i.pageFrom && parentPages(x.parentId) === mine && (x.classification?.productNames || []).length === 1 && x.classification.question !== "product");
      const pick = majority(same.map((x) => x.classification.productNames[0]));
      const from = pick ? items.find((x) => x.id === same.find((s) => s.classification.productNames[0] === pick).parentId) : null;
      if (pick && names.length === 1 && names[0] === pick) {
        p.question = null;
        p.evidence = [...p.evidence, { from: "drop", page: i.pageFrom, says: `page ${i.pageFrom} of ${from?.name || "another file"} is ${pick} too` }];
      } else {
        if (pick) p.suggested = { name: pick, says: `page ${i.pageFrom} of ${from?.name || "another file"} is ${pick}` };
        p.question = "product";
      }
    }
    p.products = names.map(productFor);
    let action = c.docType;
    if (c.docType === "label" && c.role === "design_source" && pdfBases.has(base(i.name))) action = "label_design";
    else if (c.docType === "certificate_filled") {
      // with no design file of its type in the drop, the issued certificate is also the template (one per type)
      const free = c.certCode && !templateFor.has(c.certCode) && !i.parentId;
      if (c.parts?.length) action = "bundle";
      else if (c.role === "issued_document") action = free ? "certificate_both" : "issued_document";
      else action = free ? "certificate_both" : "certificate_filled";
      if (free) {
        templateFor.set(c.certCode, i.id);
        p.makeTemplate = true;
        if (action === "bundle") action = "bundle_template";
      }
    } else if (c.docType === "certificate_template" && templateFor.get(c.certCode) !== i.id) action = "certificate_filled"; // a second template of a type: kept, not a second template
    p.action = action;
    p.actionText = ACTIONS[action] || ACTIONS.other;
    if (c.docType === "label" && !p.country) p.question = p.question || "country";
    out.set(i.id, p);
  }
  return { proposals: out, dropCompany: company, dropBrand: brand, dropCountry };
}

/** The new companies / brands / products the proposals (after the person's changes) would create. */
export function newEntities(effective) {
  const uniq = (list) => [...new Map(list.map((x) => [norm(x.name), x])).values()];
  const live = effective.filter((e) => !["duplicate", "skip"].includes(e.action));
  return {
    companies: uniq(live.map((e) => e.company).filter((c) => c?.isNew)),
    brands: uniq(live.map((e) => e.brand).filter((b) => b?.isNew)),
    products: uniq(live.flatMap((e) => e.products || []).filter((p) => p.isNew)),
    certificateTypes: [...new Set(live.filter((e) => ["certificate_template", "certificate_both", "bundle_template"].includes(e.action)).map((e) => e.certCode).filter(Boolean))],
  };
}
