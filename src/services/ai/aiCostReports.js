import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import AppError from "../../utils/appError.js";
import { CertError } from "../certificates/errors.js";

// AI cost ledger — reports. Everything here SUMS ai_calls rows; no cost is
// computed here (each row carries the cost priced at call time). Tenancy: the
// caller passes `companyId` — a company session is forced to itself by the
// controller; a system user may name one or pass none for all companies.

const DAY = 86_400_000;
const num = (d) => (d === null || d === undefined ? 0 : Number(d));
const round = (x) => Math.round(x * 1e8) / 1e8;

/** { from, to } as Dates: default the last 30 days; `to` is inclusive of its whole day. */
export function rangeOf({ from, to } = {}) {
  const end = to ? new Date(`${String(to).slice(0, 10)}T00:00:00Z`).getTime() + DAY : Date.now();
  const start = from ? new Date(`${String(from).slice(0, 10)}T00:00:00Z`).getTime() : end - 30 * DAY;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new CertError("BAD_RANGE", "from must be a date before to (YYYY-MM-DD)", 400);
  if (end - start > 732 * DAY) throw new CertError("BAD_RANGE", "A report covers at most two years", 400);
  return { from: new Date(start), to: new Date(end) };
}

const whereOf = ({ companyId, from, to }) => ({ ...(companyId ? { companyId } : {}), createdAt: { gte: from, lt: to } });
const sqlCompany = (companyId) => (companyId ? Prisma.sql`AND "company_id" = ${companyId}` : Prisma.empty);

const SUMS = { inputTokens: true, cachedTokens: true, outputTokens: true, thinkingTokens: true, latencyMs: true, costUsd: true };
const shape = (g) => ({
  attempts: g._count._all,
  inputTokens: num(g._sum.inputTokens),
  cachedTokens: num(g._sum.cachedTokens),
  outputTokens: num(g._sum.outputTokens),
  thinkingTokens: num(g._sum.thinkingTokens),
  costUsd: round(num(g._sum.costUsd)),
});

async function companyNames(ids) {
  const rows = ids.length ? await prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  return new Map(rows.map((c) => [c.id, c.name]));
}

/** GET /ai-costs/summary — totals, then per company / feature / model / day. */
export async function costSummary({ companyId = null, from, to } = {}) {
  const range = rangeOf({ from, to });
  const where = whereOf({ companyId, ...range });
  const group = (by) => prisma.aiCall.groupBy({ by, where, _count: { _all: true }, _sum: SUMS });
  const [total, unpriced, failed, byCompany, byFeature, byModel, byDay] = await Promise.all([
    prisma.aiCall.aggregate({ where, _count: { _all: true }, _sum: SUMS }),
    prisma.aiCall.count({ where: { ...where, costUsd: null } }),
    prisma.aiCall.count({ where: { ...where, outcome: { not: "ok" } } }),
    group(["companyId"]),
    group(["feature"]),
    group(["modelId"]),
    prisma.$queryRaw`
      SELECT to_char(date_trunc('day', "created_at"), 'YYYY-MM-DD') AS day,
             count(*)::int AS attempts,
             coalesce(sum("input_tokens"), 0)::bigint AS "inputTokens",
             coalesce(sum("cached_tokens"), 0)::bigint AS "cachedTokens",
             coalesce(sum("output_tokens"), 0)::bigint AS "outputTokens",
             coalesce(sum("thinking_tokens"), 0)::bigint AS "thinkingTokens",
             coalesce(sum("cost_usd"), 0) AS "costUsd"
      FROM "ai_calls"
      WHERE "created_at" >= ${range.from} AND "created_at" < ${range.to} ${sqlCompany(companyId)}
      GROUP BY 1 ORDER BY 1`,
  ]);
  const names = await companyNames(byCompany.map((g) => g.companyId).filter(Boolean));
  const byCost = (a, b) => b.costUsd - a.costUsd || b.attempts - a.attempts;
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    companyId,
    totals: { ...shape(total), failedAttempts: failed, unpricedAttempts: unpriced },
    byCompany: byCompany.map((g) => ({ companyId: g.companyId, companyName: g.companyId ? names.get(g.companyId) ?? null : null, ...shape(g) })).sort(byCost),
    byFeature: byFeature.map((g) => ({ feature: g.feature, ...shape(g) })).sort(byCost),
    byModel: byModel.map((g) => ({ modelId: g.modelId, ...shape(g) })).sort(byCost),
    byDay: byDay.map((d) => ({ day: d.day, attempts: d.attempts, inputTokens: num(d.inputTokens), cachedTokens: num(d.cachedTokens), outputTokens: num(d.outputTokens), thinkingTokens: num(d.thinkingTokens), costUsd: round(num(d.costUsd)) })),
  };
}

/**
 * GET /ai-costs/top — the most expensive operations. An operation is one
 * ai_runs operation (aiRunId) when there is one, else everything one feature
 * did for one entity (a label generation task, a regulatory document…), else
 * the single attempt.
 */
export async function topOperations({ companyId = null, from, to, limit = 20 } = {}) {
  const range = rangeOf({ from, to });
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const rows = await prisma.$queryRaw`
    SELECT coalesce("ai_run_id", "feature" || ':' || "entity_type" || ':' || "entity_id", "id") AS "operationKey",
           min("feature") AS feature, min("company_id") AS "companyId",
           min("entity_type") AS "entityType", min("entity_id") AS "entityId",
           min("parent_type") AS "parentType", min("parent_id") AS "parentId",
           min("ai_run_id") AS "aiRunId", min("model_id") AS "modelId",
           count(*)::int AS attempts,
           coalesce(sum("input_tokens"), 0)::bigint AS "inputTokens",
           coalesce(sum("output_tokens"), 0)::bigint AS "outputTokens",
           coalesce(sum("thinking_tokens"), 0)::bigint AS "thinkingTokens",
           coalesce(sum("cost_usd"), 0) AS "costUsd",
           min("created_at") AS "startedAt", max("created_at") AS "endedAt"
    FROM "ai_calls"
    WHERE "created_at" >= ${range.from} AND "created_at" < ${range.to} ${sqlCompany(companyId)}
    GROUP BY 1
    ORDER BY sum("cost_usd") DESC NULLS LAST, count(*) DESC
    LIMIT ${n}`;
  const names = await companyNames([...new Set(rows.map((r) => r.companyId).filter(Boolean))]);
  return rows.map((r) => ({
    ...r,
    companyName: r.companyId ? names.get(r.companyId) ?? null : null,
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    thinkingTokens: num(r.thinkingTokens),
    costUsd: round(num(r.costUsd)),
  }));
}

/**
 * Which ledger rows make up one business entity end to end, after checking it
 * belongs to the caller's company (another company's → 404, never 403).
 * Only rows billed to the entity's own company count: an id is not proof of
 * ownership, so another tenant's row naming the same id never leaks in.
 *   invoice   — its own calls + calls made for it on another entity (web lookups)
 *   template  — every version's calls
 *   catalogue — every edition's calls
 *   label     — its own calls + its generation job's (linked once it existed)
 */
async function entityWhere(type, id, companyId) {
  const own = (row) => row && (!companyId || row.companyId === companyId);
  if (type === "invoice") {
    const inv = await prisma.invoice.findUnique({ where: { id }, select: { companyId: true } });
    if (!own(inv)) throw new AppError("Invoice not found", 404);
    return { companyId: inv.companyId, OR: [{ entityType: "invoice", entityId: id }, { parentType: "invoice", parentId: id }] };
  }
  if (type === "template") {
    const t = await prisma.certificateTemplate.findUnique({ where: { id }, select: { companyId: true, versions: { select: { id: true } } } });
    if (!own(t)) throw new AppError("Template not found", 404);
    return { companyId: t.companyId, OR: [{ entityType: "template", entityId: id }, { entityType: "template_version", entityId: { in: t.versions.map((v) => v.id) } }] };
  }
  if (type === "catalogue") {
    const c = await prisma.catalogue.findUnique({ where: { id }, select: { companyId: true, versions: { select: { id: true } } } });
    if (!own(c)) throw new AppError("Catalogue not found", 404);
    return { companyId: c.companyId, OR: [{ entityType: "catalogue", entityId: id }, { entityType: "catalogue_version", entityId: { in: c.versions.map((v) => v.id) } }] };
  }
  if (type === "label") {
    const l = await prisma.generatedLabel.findUnique({ where: { id }, select: { companyId: true } });
    if (!own(l)) throw new AppError("Label not found", 404);
    // generation is billed to its task first, then linked to the label (linkTaskCalls)
    return { companyId: l.companyId, OR: [{ entityType: "label", entityId: id }, { parentType: "label", parentId: id }] };
  }
  throw new CertError("BAD_ENTITY", "type must be invoice, template, catalogue or label", 400);
}

/** GET /ai-costs/entity?type=&id= — "AI cost: …" on that entity's page. */
export async function entityCost({ type, id, companyId = null }) {
  const where = await entityWhere(type, id, companyId);
  const [total, unpriced, byFeature] = await Promise.all([
    prisma.aiCall.aggregate({ where, _count: { _all: true }, _sum: SUMS }),
    prisma.aiCall.count({ where: { ...where, costUsd: null } }),
    prisma.aiCall.groupBy({ by: ["feature"], where, _count: { _all: true }, _sum: SUMS }),
  ]);
  return { type, id, ...shape(total), unpricedAttempts: unpriced, byFeature: byFeature.map((g) => ({ feature: g.feature, ...shape(g) })).sort((a, b) => b.costUsd - a.costUsd) };
}

const CSV_COLUMNS = ["createdAt", "companyId", "companyName", "userId", "feature", "entityType", "entityId", "parentType", "parentId", "aiRunId", "modelId", "attempt", "outcome", "httpStatus", "inputTokens", "cachedTokens", "outputTokens", "thinkingTokens", "latencyMs", "costUsd", "priceEffectiveFrom", "priceInputPerM", "priceCachedPerM", "priceOutputPerM"];
const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  // a leading = + - @ would run as a formula in a spreadsheet
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** GET /ai-costs/export.csv — one line per attempt, oldest first. */
export async function* exportCsv({ companyId = null, from, to } = {}) {
  const range = rangeOf({ from, to });
  const where = whereOf({ companyId, ...range });
  yield `${CSV_COLUMNS.join(",")}\n`;
  const names = new Map();
  let cursor = null;
  for (;;) {
    const rows = await prisma.aiCall.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 2000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!rows.length) break;
    const missing = [...new Set(rows.map((r) => r.companyId).filter((c) => c && !names.has(c)))];
    for (const [k, v] of await companyNames(missing)) names.set(k, v);
    yield rows.map((r) => CSV_COLUMNS.map((c) => csvCell(c === "companyName" ? names.get(r.companyId) : r[c])).join(",")).join("\n") + "\n";
    cursor = rows[rows.length - 1].id;
  }
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthRange = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return { from: new Date(Date.UTC(y, mo - 1, 1)), to: new Date(Date.UTC(y, mo, 1)) };
};

/**
 * GET /ai-costs/reconciliation — the ledger's total per month next to what
 * Google Cloud billed (entered by a system user), and the difference. All
 * companies: Google bills the project, not a tenant.
 */
export async function reconciliation({ months = 12 } = {}) {
  const n = Math.min(Math.max(Number(months) || 12, 1), 36);
  const now = new Date();
  const list = Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const first = monthRange(list[list.length - 1]).from;
  const [sums, billed] = await Promise.all([
    prisma.$queryRaw`
      SELECT to_char(date_trunc('month', "created_at"), 'YYYY-MM') AS month,
             count(*)::int AS attempts,
             count(*) FILTER (WHERE "cost_usd" IS NULL)::int AS "unpricedAttempts",
             coalesce(sum("cost_usd"), 0) AS "ledgerUsd"
      FROM "ai_calls" WHERE "created_at" >= ${first}
      GROUP BY 1`,
    prisma.aiBillingMonth.findMany({ where: { month: { in: list } } }),
  ]);
  const byMonth = new Map(sums.map((s) => [s.month, s]));
  const bill = new Map(billed.map((b) => [b.month, b]));
  return list.map((month) => {
    const s = byMonth.get(month);
    const b = bill.get(month);
    const ledgerUsd = round(num(s?.ledgerUsd));
    const billedUsd = b ? num(b.billedUsd) : null;
    return {
      month,
      attempts: s?.attempts ?? 0,
      unpricedAttempts: s?.unpricedAttempts ?? 0,
      ledgerUsd,
      billedUsd,
      differenceUsd: billedUsd === null ? null : round(billedUsd - ledgerUsd),
      note: b?.note ?? null,
      updatedAt: b?.updatedAt ?? null,
    };
  });
}

/** PUT /ai-costs/reconciliation/:month — what Google Cloud billing charged. */
export async function setBilledAmount(month, { billedUsd, note = null }, userId = null) {
  if (!MONTH.test(month)) throw new CertError("BAD_MONTH", "month must be YYYY-MM", 400);
  const amount = Number(billedUsd);
  if (!Number.isFinite(amount) || amount < 0) throw new CertError("BAD_AMOUNT", "billedUsd must be a number ≥ 0", 400);
  await prisma.aiBillingMonth.upsert({
    where: { month },
    create: { month, billedUsd: amount, note: note || null, updatedByUserId: userId },
    update: { billedUsd: amount, note: note || null, updatedByUserId: userId },
  });
  return (await reconciliation({ months: 36 })).find((r) => r.month === month) ?? { month, billedUsd: amount };
}
