// Part C of the 28 Nov add-on: what stays protected — lab results, batch / lot number, batch size,
// production and expiry dates — is never estimated and never copied from a design's sample. When it is
// missing, the drafts are still made with everything else filled, and:
//   1. ONE Arabic message lists what is missing, per product and certificate (missingMessageAr);
//   2. the person answers in one chat line — "ADDHEPA باتش MADADD2610001 إنتاج 01/10/2026 — pH 6.4 assay 99%"
//      — parsed HERE by code (parseBatchLine), never by the model: every value is a piece of the person's
//      own words; dates are read day/month/year; an expiry may be computed from a real production date
//      and the product's validity (Phase 3);
//   3. the drafts get a new version with those values (applyAnswer) — the same edit a person makes.
// Batch facts a real manufacturing order or lab report of the drop prints fill the same way (fromDocuments).
import { prisma } from "../../../lib/prisma.js";
import { editValues } from "../certificates/editService.js";
import { listFields } from "../templates/fieldService.js";
import { applyFormat } from "./valueResolver.js";

const ROLE_AR = { batchNo: "رقم التشغيلة", productionDate: "تاريخ الإنتاج", expiryDate: "تاريخ الانتهاء", batchSize: "حجم التشغيلة" };
const BLOCKING = new Set(["missing", "sample_value"]);
const normTest = (s) => String(s || "").toLowerCase().replace(/ﬁ/g, "fi").replace(/\s*(result|النتيجة|نتيجة)\s*$/i, "").replace(/[^a-z0-9؀-ۿ]+/g, "");

/** What a field holds, for the answer → { role: batchNo|productionDate|expiryDate|batchSize|result|other, test? } */
export function fieldRole(f) {
  const path = f.source?.kind === "item" ? String(f.source.path || "") : "";
  if (["batchNo", "productionDate", "expiryDate"].includes(path)) return { role: path };
  const label = String(f.label || "");
  if (/\b(batch|lot)\s*size\b|حجم/i.test(label)) return { role: "batchSize" };
  if (f.isLabResult) return { role: "result", test: label.replace(/\s*result\s*$/i, "").trim() || f.key };
  if (f.isBatchFact) {
    if (/expir|exp\.?\s*date|انتهاء/i.test(label)) return { role: "expiryDate" };
    if (/produc|manufact|mfg|إنتاج|انتاج/i.test(label)) return { role: "productionDate" };
    if (/batch|lot|تشغيلة/i.test(label)) return { role: "batchNo" };
  }
  return { role: "other" };
}

/** The drafts' blocking places → [{ certificateId, product, code, items: [{ key, label, role, test? }] }] */
export async function missingFor(certificateIds) {
  const certs = await prisma.certificate.findMany({ where: { id: { in: certificateIds } }, include: { certificateType: { select: { code: true } }, product: { select: { id: true, name: true } } } });
  const out = [];
  for (const c of certs) {
    const v = await prisma.certificateVersion.findUnique({ where: { certificateId_versionNumber: { certificateId: c.id, versionNumber: c.currentVersion } }, select: { values: true } });
    const fields = await listFields(c.templateVersionId);
    const items = [];
    for (const f of fields) {
      const val = v?.values?.[f.key];
      if (!val || !(val.flags || []).some((x) => BLOCKING.has(x))) continue;
      items.push({ key: f.key, label: f.label, ...fieldRole(f) });
    }
    if (items.length) out.push({ certificateId: c.id, productId: c.product?.id || null, product: c.product?.name || "—", code: c.certificateType.code, items });
  }
  return out;
}

/** The ONE message: what's missing, per product, and how to answer in one line */
export function missingMessageAr(list) {
  if (!list.length) return null;
  const byProduct = new Map();
  for (const m of list) {
    if (!byProduct.has(m.product)) byProduct.set(m.product, []);
    byProduct.get(m.product).push(m);
  }
  const lines = [];
  for (const [product, ms] of byProduct) {
    const batch = new Set();
    const tests = new Set();
    const other = new Set();
    for (const m of ms) for (const it of m.items) {
      if (ROLE_AR[it.role]) batch.add(ROLE_AR[it.role]);
      else if (it.role === "result") tests.add(it.test);
      else other.add(it.label);
    }
    const parts = [...batch];
    if (tests.size) parts.push(`نتايج التحليل: ${[...tests].join("، ")}`);
    if (other.size) parts.push(`و${[...other].join("، ")}`);
    lines.push(`• ${product} (${[...new Set(ms.map((m) => m.code))].join("، ")}): ${parts.join("، ")}`);
  }
  const first = [...byProduct.keys()][0];
  return [
    "الشهادات اتعملت وكل البيانات اللي في الملفات اتملت. فاضل بيانات التشغيلة ونتايج التحليل — دي مبنكتبهاش من عندنا ولا من نموذج الشهادة:",
    ...lines,
    `ابعتهم في سطر واحد لكل منتج، مثلاً: ${first} باتش MADADD2610001 إنتاج 01/10/2026 حجم 1200 KG — pH 6.4 assay 99%`,
  ].join("\n");
}

// ── the one-line answer ───────────────────────────────────────────────────────────────────
const DATE = String.raw`(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{1,2}[\/.\-]\d{4}|\d{4}-\d{2}-\d{2})`;
const RE = {
  batchNo: /(?:باتش|التشغيلة|تشغيلة|لوط|batch\s*(?:no\.?|number|#)?|lot\s*(?:no\.?|#)?)\s*[:#]?\s*(?!size\b)([A-Za-z0-9][A-Za-z0-9\-\/]{2,})/i,
  productionDate: new RegExp(String.raw`(?:الإنتاج|الانتاج|إنتاج|انتاج|production(?:\s*date)?|prod\.?|mfg\.?|mfd\.?|manufactur\w*(?:\s*date)?)\s*[:]?\s*` + DATE, "i"),
  expiryDate: new RegExp(String.raw`(?:الانتهاء|انتهاء|صلاحية|الصلاحية|expiry(?:\s*date)?|exp\.?)\s*[:]?\s*` + DATE, "i"),
  batchSize: /(?:حجم(?:\s*التشغيلة)?|batch\s*size|lot\s*size)\s*[:]?\s*([\d.,]+\s*(?:kg|KG|Kg|g|L|l|lt|liters?|litres?|لتر|كجم|كيلو|ton|طن|units?|vials?|bottles?)?)/i,
};
const RESULT_VALUE = String.raw`(-?\d+(?:[.,]\d+)?\s*(?:%|ppm|mg\/?\w*|IU\/?\w*|cfu\/?\w*)?|conforms?|complies|positive|negative|pass(?:es)?|sterile|non[- ]?pyrogenic|absent|مطابق(?:ة)?|سلبي|إيجابي)`;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "01/10/2026" (day first) / "10/2026" / "2026-10-01" → ISO date, or null */
export function isoOf(s) {
  const t = String(s || "").trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  m = t.match(/^(\d{1,2})[\/.\-](\d{4})$/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return `${m[2]}-${String(Number(m[1])).padStart(2, "0")}-01`;
  return null;
}

/**
 * One chat line → per product: { product|null, batchNo, productionDate, expiryDate, batchSize, results: { normTest: value } }
 * products: known names (the longest one written in a part wins); tests: the test names still missing.
 */
export function parseBatchLine(text, { products = [], tests = [] } = {}) {
  const out = [];
  const segments = String(text || "").split(/[\n;؛]+/).map((s) => s.trim()).filter(Boolean);
  const names = [...products].sort((a, b) => b.length - a.length);
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    const product = names.find((n) => lower.includes(String(n).toLowerCase())) || null;
    const rest = product ? seg.replace(new RegExp(escapeRe(product), "i"), " ") : seg;
    const a = { product, results: {} };
    for (const [k, re] of Object.entries(RE)) {
      const m = rest.match(re);
      if (m) a[k] = m[1].trim();
    }
    for (const t of new Set(tests)) {
      const m = rest.match(new RegExp(`(?:^|[\\s—\\-–,،:(])${escapeRe(t)}\\s*[:=]?\\s*${RESULT_VALUE}`, "i"));
      if (m) a.results[normTest(t)] = m[1].trim();
    }
    if (a.batchNo || a.productionDate || a.expiryDate || a.batchSize || Object.keys(a.results).length) out.push(a);
  }
  return out;
}

/** "36 months from the production date" / "3 years" / "24 شهر" → months, or null */
export function validityMonths(v) {
  const m = String(v || "").match(/(\d+)\s*(months?|month|شهر|شهور|أشهر|years?|year|سنة|سنوات|سنين)/i);
  if (!m) return null;
  return /year|سن/i.test(m[2]) ? Number(m[1]) * 12 : Number(m[1]);
}
const addMonths = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/** One certificate's changes from an answer → { changes: { key: printed }, filled: [label], computed: [label] } */
async function changesFor(cert, answer, values) {
  const fields = await listFields(cert.templateVersionId);
  const product = cert.productId ? await prisma.product.findUnique({ where: { id: cert.productId }, select: { validity: true } }) : null;
  const prodIso = answer.productionDate ? isoOf(answer.productionDate) : null;
  let expIso = answer.expiryDate ? isoOf(answer.expiryDate) : null;
  const computed = [];
  // expiry = a real production date + the product's validity (only when the person didn't give it)
  if (!expIso && prodIso && validityMonths(product?.validity)) {
    expIso = addMonths(prodIso, validityMonths(product.validity));
    computed.push("expiryDate");
  }
  const changes = {};
  const filled = [];
  for (const f of fields) {
    const cur = values?.[f.key];
    if (!cur || cur.kind === "group" || cur.origin === "manual") continue; // never over what a person typed
    const { role, test } = fieldRole(f);
    let raw = null;
    if (role === "batchNo") raw = answer.batchNo;
    else if (role === "batchSize") raw = answer.batchSize;
    else if (role === "productionDate") raw = prodIso;
    else if (role === "expiryDate") raw = expIso;
    else if (role === "result") raw = answer.results?.[normTest(test)] ?? null;
    if (!raw) continue;
    const printed = role === "productionDate" || role === "expiryDate" ? applyFormat(raw, f.format || { date: "DD/MM/YYYY" }).value : raw;
    changes[f.key] = printed;
    filled.push(f.label);
  }
  return { changes, filled, computed };
}

/**
 * Apply a parsed answer to drafts. answers: parseBatchLine's output. A part naming a product goes to
 * that product's drafts; one part without a product goes to the drafts when they are all one product.
 * → [{ certificateId, product, filled: [label], computed, skipped? }]
 */
export async function applyAnswer({ companyId, userId = null, certificateIds, answers, dryRun = false }) {
  const certs = await prisma.certificate.findMany({ where: { id: { in: certificateIds }, companyId }, include: { product: { select: { name: true } } } });
  const productNames = new Set(certs.map((c) => c.product?.name).filter(Boolean));
  const results = [];
  for (const c of certs) {
    const mine = answers.find((a) => a.product && c.product?.name && a.product.toLowerCase() === c.product.name.toLowerCase()) || (answers.length === 1 && !answers[0].product && productNames.size <= 1 ? answers[0] : null);
    if (!mine) {
      results.push({ certificateId: c.id, product: c.product?.name || null, filled: [], skipped: answers.some((a) => !a.product) && productNames.size > 1 ? "which_product" : "not_named" });
      continue;
    }
    if (c.status === "final") {
      results.push({ certificateId: c.id, product: c.product?.name || null, filled: [], skipped: "final" });
      continue;
    }
    const v = await prisma.certificateVersion.findUnique({ where: { certificateId_versionNumber: { certificateId: c.id, versionNumber: c.currentVersion } }, select: { values: true } });
    const { changes, filled, computed } = await changesFor(c, mine, v?.values);
    // dryRun: what the card shows before the person presses it
    if (!dryRun && Object.keys(changes).length) await editValues(c.id, companyId, userId, { expectedVersion: c.currentVersion, changes });
    results.push({ certificateId: c.id, product: c.product?.name || null, filled, computed, changes: dryRun ? changes : undefined });
  }
  return results;
}

/**
 * Batch facts a real manufacturing order / lab report of the company prints (harvest, confirmed) → the
 * drafts of those products, as if typed (one batch per product only: two batches → left for the person).
 * → applyAnswer's result
 */
export async function fromDocuments({ companyId, certificateIds }) {
  const certs = await prisma.certificate.findMany({ where: { id: { in: certificateIds }, companyId }, select: { productId: true, product: { select: { name: true } } } });
  const answers = [];
  for (const pid of new Set(certs.map((c) => c.productId).filter(Boolean))) {
    const facts = await prisma.harvestedFact.findMany({ where: { companyId, productId: pid, perBatch: true, reviewStatus: "confirmed", sourceType: { in: ["mo", "lab"] } } });
    const batches = new Set(facts.map((f) => f.batchNo).filter(Boolean));
    if (batches.size !== 1) continue;
    const pick = (k) => facts.find((f) => f.key === k)?.value ?? null;
    const results = Object.fromEntries(facts.filter((f) => f.key.startsWith("result:")).map((f) => [normTest(f.key.slice(7)), String(f.value)]));
    answers.push({ product: certs.find((c) => c.productId === pid)?.product?.name || null, batchNo: [...batches][0], productionDate: pick("productionDate"), expiryDate: pick("expiryDate"), batchSize: pick("batchSize"), results });
  }
  if (!answers.length) return [];
  return applyAnswer({ companyId, certificateIds, answers: answers.filter((a) => a.product) });
}
