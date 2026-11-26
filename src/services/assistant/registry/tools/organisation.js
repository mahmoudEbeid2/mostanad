import { z } from "zod";
import { defineTool } from "../registry.js";
import { mayUse } from "../access.js";
import { page, pick, ref } from "../trim.js";
import { pageArgs, id, pg, dateArg } from "./common.js";
import { getAllCompanies, getCompanyById } from "../../../companyService.js";
import { getAllUsers } from "../../../userService.js";
import { getAllRoles } from "../../../roleService.js";
import { getDashboardStatsData } from "../../../dashboardService.js";
import { costSummary, topOperations } from "../../../ai/aiCostReports.js";
import { getTask, countEntities, COUNT_ENTITIES, COUNT_GROUPS, COUNT_PERIODS } from "../../reads.js";
import { prisma } from "../../../../lib/prisma.js";

const COMPANY_FIELDS = ["id", "name", "username", "email", "phone", "address", "isActive", "createdAt"];

// ── companies ───────────────────────────────────────────────────────────────
defineTool({
  name: "list_companies",
  module: "companies",
  core: true,
  risk: "read",
  systemOnly: true,
  permissions: ["read_companies"],
  companyArg: false,
  label: "Listing companies",
  description: "Every company in the system (system users only): id, name, active. Use it to find a company's id from its name before passing companyId to another tool.",
  args: z.object({ q: z.string().max(80).optional().describe("Part of the name, username or email"), ...pageArgs }),
  run: async (a) => {
    const { page: p, limit } = pg(a);
    const { meta, companies } = await getAllCompanies({ page: String(p), limit: String(limit), sort: "name", ...(a.q ? { search: a.q } : {}) });
    return page(companies.map((c) => ({ id: c.id, name: c.name, isActive: c.isActive, ref: ref("company", c) })), meta?.total, { page: p, limit });
  },
});

defineTool({
  name: "get_company",
  module: "companies",
  core: true,
  risk: "read",
  label: "Reading the company",
  description: "The current company's details (name, contact, active). A company session always gets its own company; a system user gets the conversation's company or the one named by companyId.",
  args: z.object({}),
  needsCompany: true,
  run: async (a, ctx) => {
    const c = await getCompanyById(ctx.companyId);
    return { ...pick(c, COMPANY_FIELDS), ref: ref("company", c) };
  },
});

// ── users and roles (read only) ─────────────────────────────────────────────
defineTool({
  name: "list_users",
  module: "users",
  risk: "read",
  systemOnly: true,
  permissions: ["read_users"],
  companyArg: false,
  label: "Listing users",
  description: "System users (staff accounts): name, username, email, role, active. Optional `q` matches name, email or username.",
  args: z.object({ q: z.string().max(80).optional(), ...pageArgs }),
  run: async (a) => {
    const { page: p, limit } = pg(a);
    const { meta, users } = await getAllUsers({ page: String(p), limit: String(limit), sort: "name", ...(a.q ? { search: a.q } : {}) });
    return page(users.map((u) => pick(u, ["id", "name", "username", "email", "roleId", "isActive", "createdAt"])), meta?.total, { page: p, limit });
  },
});

defineTool({
  name: "list_roles",
  module: "users",
  risk: "read",
  systemOnly: true,
  permissions: ["read_roles"],
  companyArg: false,
  label: "Listing roles",
  description: "Roles and the permissions each one grants (permission slugs such as read_products, create_certificates).",
  args: z.object({ ...pageArgs }),
  run: async (a) => {
    const { page: p, limit } = pg(a);
    const { meta, roles } = await getAllRoles({ page: String(p), limit: String(limit), sort: "name" });
    return page(roles.map((r) => ({ id: r.id, name: r.name, description: r.description, permissions: r.permissions.map((rp) => rp.permission.slug) })), meta?.total, { page: p, limit });
  },
});

// ── dashboard, AI costs, tasks ──────────────────────────────────────────────
defineTool({
  name: "get_dashboard_stats",
  module: "dashboard",
  risk: "read",
  systemOnly: true,
  permissions: ["read_dashboard"],
  companyArg: false,
  label: "Reading the dashboard",
  description: "System-wide dashboard numbers (system users only): totals and 30-day growth of products, companies, users, plans; active subscriptions and revenue.",
  args: z.object({}),
  run: () => getDashboardStatsData(),
});

defineTool({
  name: "get_ai_cost_summary",
  module: "ai_costs",
  risk: "read",
  permissions: ["read_ai_costs"],
  label: "Reading AI costs",
  description:
    "AI usage and cost from the ledger for a date range (default this month): totals (attempts, tokens, cost in USD, failed, unpriced), by feature, by model, by day, and — for all companies — by company. " +
    "Unpriced calls have no cost: say the cost is unknown rather than $0.",
  args: z.object({ from: dateArg("Start"), to: dateArg("End (exclusive)") }),
  run: async (a, ctx) => {
    const s = await costSummary({ companyId: ctx.companyId || null, from: a.from, to: a.to });
    return { ...s, byCompany: ctx.companyId ? undefined : s.byCompany, byDay: s.byDay.slice(-31) };
  },
});

defineTool({
  name: "get_ai_cost_top",
  module: "ai_costs",
  risk: "read",
  permissions: ["read_ai_costs"],
  label: "Reading the costliest AI operations",
  description: "The most expensive AI operations in a date range (default this month): what it was for, its cost, attempts and tokens.",
  args: z.object({ from: dateArg("Start"), to: dateArg("End (exclusive)"), limit: z.number().int().min(1).max(20).optional() }),
  run: (a, ctx) => topOperations({ companyId: ctx.companyId || null, from: a.from, to: a.to, limit: a.limit || 10 }),
});

defineTool({
  name: "get_task_status",
  module: "tasks",
  core: true,
  risk: "read",
  label: "Reading the task",
  description:
    "The status of a background task (an upload, extraction, generation, a files' read): status, progress, stage, message, error. " +
    "taskId is optional: \"إيه حالة المهمة؟\" / \"الرفع خلص؟\" with no id → the latest tasks of this company (running first). " +
    "One running task → answer about it; several → say which are running and list them (the person picks one).",
  args: z.object({ taskId: id("background task").optional() }),
  run: async (a, ctx) => {
    if (a.taskId) return getTask(a.taskId, ctx.companyId);
    // Phase 7: no id — the latest tasks of the company in view (a system user without one: everyone's)
    const rows = await prisma.backgroundTask.findMany({ where: { ...(ctx.companyId ? { companyId: ctx.companyId } : {}), type: { notIn: ["certificate_dictionary", "dictionary_rebuild"] } }, orderBy: { createdAt: "desc" }, take: 8, select: { id: true, type: true, status: true, progress: true, message: true, stage: true, error: true, createdAt: true, updatedAt: true } });
    if (!rows.length) return { tasks: [], note: "No background task for this company yet." };
    const running = rows.filter((t) => ["queued", "pending", "active", "running", "processing"].includes(t.status));
    const view = (t) => ({ taskId: t.id, type: t.type, status: t.status, progress: t.progress ?? null, stage: t.stage || null, message: ["queued", "pending", "processing", "running"].includes(t.status) ? t.message || null : null, error: t.error || null, started: t.createdAt, updated: t.updatedAt });
    if (running.length === 1) return { latest: view(running[0]), others: rows.filter((t) => t !== running[0]).slice(0, 3).map(view) };
    return { running: running.map(view), recent: rows.filter((t) => !running.includes(t)).slice(0, 5).map(view), note: running.length > 1 ? "Several tasks are running: name them and ask which one (or report all)." : "Nothing is running now: report the latest one." };
  },
});

// ── reports ─────────────────────────────────────────────────────────────────
defineTool({
  name: "count_records",
  module: "reports",
  core: true,
  risk: "read",
  label: "Counting",
  description:
    `How many ${COUNT_ENTITIES.join(", ")} were created in a period, grouped by one of: ${COUNT_GROUPS.join(", ")}. ` +
    `Periods are Cairo days and a week is Saturday–Friday: pass period (${COUNT_PERIODS.join(", ")}) — e.g. "this week" → this_week — or from/to dates. ` +
    "type = certificate type (certificates, templates), brand (products), country (labels). groupBy company lists every company the user can see, zero included. " +
    "status filters (certificates: draft, final, failed, pending). The result states the exact date range: say it. Use this for every count or report — never count by listing.",
  args: z.object({
    entity: z.enum(COUNT_ENTITIES),
    groupBy: z.enum(COUNT_GROUPS).optional(),
    period: z.enum(COUNT_PERIODS).optional(),
    from: dateArg("Start (Cairo date), when no period"),
    to: dateArg("End (Cairo date, exclusive), when no period"),
    status: z.string().max(30).optional(),
  }),
  // the permission depends on the entity: checked here with the same rule as the routes
  run: (a, ctx) => {
    const need = { certificates: "read_certificates", invoices: "read_invoices", labels: "read_labels", products: "read_products", templates: "read_certificate_templates", catalogues: "read_products" }[a.entity];
    if (!mayUse(ctx.actor, need)) return { error: `You don't have permission to count ${a.entity}.` };
    return countEntities(ctx.companyId, { entity: a.entity, groupBy: a.groupBy || "none", period: a.period, from: a.from, to: a.to, status: a.status });
  },
});
