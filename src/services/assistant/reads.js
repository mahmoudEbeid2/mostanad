import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import AppError from "../../utils/appError.js";

// Read services the assistant needs where the existing ones don't take a
// company scope (the V1 brand / reference-label / regulatory lists filter by
// query string only), plus reports. companyId: a company id, or null = every
// company (only ever null for a system user — the registry decides). Nothing
// here writes.

const notFound = (what) => new AppError(`${what} not found!`, 404);
const take = (limit, max = 25) => Math.min(Math.max(Number(limit) || 10, 1), max);
const skipOf = (page, limit) => (Math.max(Number(page) || 1, 1) - 1) * take(limit);
const inScope = (row, companyId) => !!row && (!companyId || row.companyId === companyId);
/** Rows a company may read: its own plus the shared (companyId null) ones — CLAUDE.md invariant 10. */
const sharedOr = (companyId) => (companyId ? { OR: [{ companyId }, { companyId: null }] } : {});

export async function listBrands(companyId, { q, page = 1, limit = 25 } = {}) {
  const where = { ...(companyId ? { companyId } : {}), ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) };
  const [total, rows] = await Promise.all([
    prisma.brand.count({ where }),
    prisma.brand.findMany({ where, orderBy: { name: "asc" }, skip: skipOf(page, limit), take: take(limit), select: { id: true, name: true, isActive: true, companyId: true, company: { select: { name: true } }, _count: { select: { products: true } } } }),
  ]);
  return { total, rows };
}

export async function getBrand(id, companyId) {
  const b = await prisma.brand.findUnique({ where: { id }, select: { id: true, name: true, isActive: true, companyId: true, company: { select: { name: true } }, _count: { select: { products: true, certificateTemplates: true, invoices: true } } } });
  if (!inScope(b, companyId)) throw notFound("Brand");
  return b;
}

export async function listRegulatoryDocuments(companyId, { country, authority, status, q, page = 1, limit = 10 } = {}) {
  const where = {
    ...sharedOr(companyId),
    ...(country ? { country: { equals: country, mode: "insensitive" } } : {}),
    ...(authority ? { authority: { equals: authority, mode: "insensitive" } } : {}),
    ...(status ? { status } : {}),
    ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.regulatoryDocument.count({ where }),
    prisma.regulatoryDocument.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: skipOf(page, limit),
      take: take(limit),
      select: { id: true, title: true, authority: true, country: true, status: true, productScope: true, documentVersion: true, effectiveDate: true, coveragePercent: true, companyId: true, createdAt: true, _count: { select: { rules: true } } },
    }),
  ]);
  return { total, rows };
}

export async function getRegulatoryDocument(id, companyId) {
  const d = await prisma.regulatoryDocument.findUnique({
    where: { id },
    select: {
      id: true, title: true, authority: true, country: true, status: true, productScope: true, sourceType: true, sourceUrl: true, sourceIsOfficial: true,
      documentVersion: true, effectiveDate: true, clauseTotal: true, clauseCovered: true, coveragePercent: true, companyId: true, createdAt: true,
      rules: { select: { id: true, ruleKey: true, ruleType: true, severity: true, status: true, description: true, citation: true }, orderBy: { createdAt: "asc" }, take: 40 },
      _count: { select: { rules: true } },
    },
  });
  if (!d || (companyId && d.companyId && d.companyId !== companyId)) throw notFound("Regulatory document");
  return d;
}

export async function listReferenceLabels(companyId, { q, country, page = 1, limit = 10 } = {}) {
  const where = {
    ...sharedOr(companyId),
    ...(country ? { country: { equals: country, mode: "insensitive" } } : {}),
    ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.referenceLabel.count({ where }),
    prisma.referenceLabel.findMany({ where, orderBy: { createdAt: "desc" }, skip: skipOf(page, limit), take: take(limit), select: { id: true, name: true, country: true, companyId: true, createdAt: true } }),
  ]);
  return { total, rows };
}

/** Invoices by number / customer across one company or (null) all — invoiceService's search needs a company. */
export async function findInvoices(companyId, { q, status, page = 1, limit = 10 } = {}) {
  const like = `%${String(q || "").replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const ids = (
    await prisma.$queryRaw`
      SELECT id FROM invoices
      WHERE ${companyId ? Prisma.sql`company_id = ${companyId}` : Prisma.sql`true`}
        AND (header->>'invoiceNumber' ILIKE ${like} OR header->>'customerName' ILIKE ${like})`
  ).map((r) => r.id);
  const where = { id: { in: ids }, ...(companyId ? { companyId } : {}), ...(status ? { status } : {}) };
  const [total, invoices] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({ where, orderBy: { createdAt: "desc" }, skip: skipOf(page, limit), take: take(limit), omit: { textContent: true }, include: { company: { select: { name: true } }, _count: { select: { items: true } } } }),
  ]);
  return { total, invoices };
}

export async function getTask(id, companyId) {
  const t = await prisma.backgroundTask.findUnique({ where: { id }, select: { id: true, type: true, status: true, progress: true, message: true, stage: true, error: true, companyId: true, createdAt: true, updatedAt: true } });
  if (!inScope(t, companyId)) throw notFound("Background task");
  return t;
}

// ── products missing data ───────────────────────────────────────────────────
export const PRODUCT_FIELDS = [
  "productCode", "description", "indications", "targetSpecies", "physicalForm", "appearance", "activeIngredients", "dosage", "mixingInstructions",
  "withdrawalPeriod", "contraindications", "userSafety", "storage", "packaging", "registrationNumber", "origin", "producer", "specifications",
  "routeOfAdmin", "dosageForm", "strength", "productType", "prescriptionStatus", "brandId", "categoryId",
];
const empty = (v) => v === null || v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
const specValues = (s) => (s && typeof s === "object" ? (s.values && typeof s.values === "object" ? s.values : s) : {});

/**
 * Products where any of `fields` is empty, or that have no specification named
 * `specification` (case-insensitive, e.g. "pH"). → { total, rows: [{ id, name, productCode, missing[] }] }
 */
export async function productsMissingData(companyId, { fields = [], specification = null, brandId = null, page = 1, limit = 20 } = {}) {
  const wanted = fields.filter((f) => PRODUCT_FIELDS.includes(f));
  const spec = specification ? String(specification).trim().toLowerCase() : null;
  const all = await prisma.product.findMany({
    where: { ...(companyId ? { companyId } : {}), ...(brandId ? { brandId } : {}) },
    select: { id: true, name: true, productCode: true, companyId: true, company: { select: { name: true } }, specifications: true, ...Object.fromEntries(wanted.map((f) => [f, true])) },
    orderBy: { name: "asc" },
    take: 5000,
  });
  const rows = [];
  for (const p of all) {
    const missing = wanted.filter((f) => empty(p[f]));
    if (spec) {
      const v = Object.entries(specValues(p.specifications)).find(([k]) => k.trim().toLowerCase() === spec)?.[1];
      if (empty(v)) missing.push(`specification "${specification}"`);
    }
    if (missing.length) rows.push({ id: p.id, name: p.name, productCode: p.productCode, companyId: p.companyId, company: p.company.name, missing });
  }
  const t = take(limit);
  const s = skipOf(page, limit);
  return { total: rows.length, checked: all.length, rows: rows.slice(s, s + t) };
}

// ── counts for reports ──────────────────────────────────────────────────────
// Periods are days in Cairo time (Africa/Cairo, DST included); a week runs
// Saturday → Friday, as the company works it (design E1: "this week, 14–20 Nov").
export const TIMEZONE = "Africa/Cairo";
export const WEEK_STARTS = "Saturday";
export const COUNT_PERIODS = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_30_days", "all"];

// entity → table, the "status" column and the "type" grouping
const COUNTABLE = {
  certificates: { table: "certificates", status: "status", type: "certificate_type_id", typeTable: "certificate_types", typeName: "name" },
  invoices: { table: "invoices", status: "status" },
  labels: { table: "generated_labels", status: "status", type: "country" },
  products: { table: "products", type: "brand_id", typeTable: "brands", typeName: "name" },
  templates: { table: "certificate_templates", type: "certificate_type_id", typeTable: "certificate_types", typeName: "name" },
  catalogues: { table: "catalogues" },
};
export const COUNT_ENTITIES = Object.keys(COUNTABLE);
export const COUNT_GROUPS = ["none", "company", "status", "type", "day", "week", "month"];

const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000));

/** Today's date in Cairo, YYYY-MM-DD. */
export function cairoToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** A named period → [from, to) as Cairo dates (YYYY-MM-DD, to exclusive), or nulls for "all". */
export function periodRange(period, now = new Date()) {
  const today = cairoToday(now);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 Sunday … 6 Saturday
  const weekStart = addDays(today, -((dow + 1) % 7)); // back to Saturday
  const monthStart = `${today.slice(0, 7)}-01`;
  const prevMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1));
  switch (period) {
    case "today":
      return [today, addDays(today, 1)];
    case "yesterday":
      return [addDays(today, -1), today];
    case "this_week":
      return [weekStart, addDays(weekStart, 7)];
    case "last_week":
      return [addDays(weekStart, -7), weekStart];
    case "this_month":
      return [monthStart, ymd(new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1)))];
    case "last_month":
      return [ymd(prevMonth), monthStart];
    case "last_30_days":
      return [addDays(today, -29), addDays(today, 1)];
    default:
      return [null, null];
  }
}

/** A Cairo-local date as the UTC timestamp the columns hold. */
const cairoMidnight = (date) => Prisma.sql`((${date}::date)::timestamp AT TIME ZONE ${TIMEZONE}) AT TIME ZONE 'UTC'`;
const LOCAL = Prisma.sql`((x."created_at" AT TIME ZONE 'UTC') AT TIME ZONE ${TIMEZONE})`;

/**
 * How many rows of `entity` were created in a period (Cairo days), grouped by one dimension.
 * Within companyId when given. Grouped by company for all companies, EVERY company is listed —
 * zero included — so a report never silently drops a company.
 * → { entity, groupBy, period, from, to, timezone, weekStarts, total, groups: [{ key, label, count }] }
 */
export async function countEntities(companyId, { entity, groupBy = "none", period = null, from = null, to = null, status = null, now = new Date() }) {
  const def = COUNTABLE[entity];
  if (!def) throw new AppError(`Can't count "${entity}"`, 400);
  if ((groupBy === "status" || status) && !def.status) throw new AppError(`${entity} have no status`, 400);
  if (groupBy === "type" && !def.type) throw new AppError(`${entity} have no type to group by`, 400);
  if (period && period !== "all") [from, to] = periodRange(period, now);
  else if (to) to = addDays(String(to).slice(0, 10), 0); // given dates are Cairo dates; to is exclusive
  if (from) from = String(from).slice(0, 10);

  const t = Prisma.raw(`"${def.table}"`);
  const conds = [];
  if (from) conds.push(Prisma.sql`x."created_at" >= ${cairoMidnight(from)}`);
  if (to) conds.push(Prisma.sql`x."created_at" < ${cairoMidnight(to)}`);
  if (status) conds.push(Prisma.sql`x.${Prisma.raw(`"${def.status}"`)} = ${status}`);

  let rows;
  if (groupBy === "company") {
    // from the companies, so a company with nothing in the period still has its row
    const on = conds.length ? Prisma.sql`AND ${Prisma.join(conds, " AND ")}` : Prisma.empty;
    rows = await prisma.$queryRaw`
      SELECT c."id" AS "key", c."name" AS "label", count(x."id")::int AS "count"
      FROM "companies" c LEFT JOIN ${t} x ON x."company_id" = c."id" ${on}
      ${companyId ? Prisma.sql`WHERE c."id" = ${companyId}` : Prisma.empty}
      GROUP BY 1, 2 ORDER BY 3 DESC, 2 LIMIT 500`;
  } else {
    if (companyId) conds.unshift(Prisma.sql`x."company_id" = ${companyId}`);
    const where = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}` : Prisma.empty;
    let key;
    let join = Prisma.empty;
    let label = Prisma.sql`NULL`;
    if (groupBy === "none") key = Prisma.sql`'all'`;
    else if (groupBy === "status") key = Prisma.raw(`x."${def.status}"`);
    else if (groupBy === "type") {
      key = Prisma.raw(`x."${def.type}"`);
      if (def.typeTable) {
        join = Prisma.raw(`LEFT JOIN "${def.typeTable}" g ON g."id" = x."${def.type}"`);
        label = Prisma.raw(`g."${def.typeName}"`);
      }
    } else if (groupBy === "day") key = Prisma.sql`to_char(${LOCAL}, 'YYYY-MM-DD')`;
    else if (groupBy === "week") key = Prisma.sql`to_char(date_trunc('day', ${LOCAL}) - ((extract(dow FROM ${LOCAL})::int + 1) % 7) * interval '1 day', 'YYYY-MM-DD')`;
    else if (groupBy === "month") key = Prisma.sql`to_char(${LOCAL}, 'YYYY-MM')`;
    else throw new AppError(`Can't group by "${groupBy}"`, 400);
    rows = await prisma.$queryRaw`
      SELECT ${key} AS "key", ${label} AS "label", count(*)::int AS "count"
      FROM ${t} x ${join} ${where}
      GROUP BY 1, 2 ORDER BY 3 DESC, 1 LIMIT 500`;
  }
  const groups = rows.map((r) => ({ key: r.key ?? null, label: r.label ?? null, count: r.count }));
  return { entity, groupBy, period: period || (from || to ? "custom" : "all"), from, to, timezone: TIMEZONE, weekStarts: WEEK_STARTS, total: groups.reduce((n, g) => n + g.count, 0), groups };
}
