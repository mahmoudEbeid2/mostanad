// Certificates V2 permissions with REAL JWTs — no bypass header (review #6).
// Every other suite authenticates with the test bypass, which skips
// restrictToPermission entirely; this one goes through protect +
// restrictToPermission exactly as production does.
//
// The route table is read from src/routes/certificatesV2Routes.js itself, so
// a route added later is covered automatically. For every route:
//   - a company token (POST /companies/login)            → never 401/403
//   - a system user whose role has ONLY that permission   → never 401/403
//   - a system user with every V2 permission EXCEPT it    → 403 (permission)
// Needs `npm run dev:test`.
import fs from "fs";
import bcrypt from "bcryptjs";
import { prisma } from "../../src/lib/prisma.js";
import { COMPANY_ALLOWED_MODULES, permissionModule } from "../../src/middleware/authMiddleware.js";

const BASE_URL = "http://127.0.0.1:3000/api/v1";
const ROUTES_FILE = new URL("../../src/routes/certificatesV2Routes.js", import.meta.url);
const DENIED = "You do not have permission to perform this action!";

let passed = 0;
let failed = 0;
function assert(label, condition, details = "") {
  if (condition) {
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}${details ? `\n     → ${typeof details === "string" ? details : JSON.stringify(details)}` : ""}`);
    failed++;
  }
}
const section = (title, before) => console.log(`  ${failed === before ? "✅" : "❌"} ${title}`);

/** [{ method, path, permission }] parsed from the router source. */
function routeTable() {
  const src = fs.readFileSync(ROUTES_FILE, "utf8");
  const re = /router\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,\s*guard\("([a-z_]+)"\)/g;
  return [...src.matchAll(re)].map(([, method, path, permission]) => ({ method: method.toUpperCase(), path, permission }));
}

// Routes a company may never use, by design: reconciliation with the Google
// Cloud bill covers the whole project (AI cost ledger). A company token must
// get 403 there; everywhere else it passes.
const SYSTEM_ONLY = new Set(["manage_ai_billing"]);

const FAKE = "00000000-0000-4000-8000-000000000000";
const fill = (path) => path.replace(/:id|:itemId/g, FAKE).replace(":key", "batch_no").replace(":n", "1").replace(":month", "2026-01");

async function call(method, path, token, body) {
  const headers = { Authorization: `Bearer ${token}`, "x-force-auth": "true" };
  const opts = { method, headers };
  if (body !== undefined && method !== "GET" && method !== "DELETE") {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${fill(path)}`, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null; // 204 / binary
  }
  return { status: res.status, data };
}

const isPermissionDenial = (r) => r.status === 403 && r.data?.message === DENIED && !r.data?.code;
const isAuthFailure = (r) => r.status === 401 || isPermissionDenial(r);

const ts = Date.now();
const created = { companies: [], users: [], roles: [] };

async function login(path, username, password) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  const body = await res.json();
  if (res.status !== 200 || !body?.data?.token) throw new Error(`login ${path} ${username} → ${res.status} ${JSON.stringify(body)}`);
  return body.data.token;
}

async function systemUser(label, slugs, perms, hash, password) {
  const role = await prisma.role.create({
    data: { name: `perm_${label}_${ts}`, permissions: { create: slugs.map((s) => ({ permissionId: perms.get(s) })) } },
  });
  created.roles.push(role.id);
  const username = `perm_${label}_${ts}`.slice(0, 60);
  const user = await prisma.user.create({ data: { name: username, username, email: `${username}@example.invalid`, password: hash, roleId: role.id } });
  created.users.push(user.id);
  return login("/auth/login", username, password);
}

async function run() {
  console.log("\n🧪 Certificates V2 — permissions with real JWTs (no bypass)");
  const routes = routeTable();
  assert("the route table was read from the router (≥ 50 guarded routes)", routes.length >= 50, routes.length);
  const slugs = [...new Set(routes.map((r) => r.permission))].sort();
  const perms = new Map((await prisma.permission.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } })).map((p) => [p.slug, p.id]));
  assert("every permission the routes use is seeded", slugs.every((s) => perms.has(s)), slugs.filter((s) => !perms.has(s)));
  const companySlugs = slugs.filter((s) => !SYSTEM_ONLY.has(s));
  assert("every V2 permission except the system-only ones is in the company allowlist", companySlugs.every((s) => COMPANY_ALLOWED_MODULES.includes(permissionModule(s))), companySlugs.filter((s) => !COMPANY_ALLOWED_MODULES.includes(permissionModule(s))));
  assert("system-only permissions are NOT in the company allowlist", [...SYSTEM_ONLY].every((s) => !COMPANY_ALLOWED_MODULES.includes(permissionModule(s))));
  console.log(`  ${routes.length} routes, ${slugs.length} permissions: ${slugs.join(", ")}`);

  const password = `Pw-${ts}-x`;
  const hash = await bcrypt.hash(password, 10);

  // a real company account
  const company = await prisma.company.create({ data: { name: `Perm co ${ts}`, username: `perm_co_${ts}`, password: hash, email: `perm_co_${ts}@example.invalid` } });
  created.companies.push(company.id);
  const companyToken = await login("/companies/login", company.username, password);

  // system users: none, only-P, all-but-P
  const noneToken = await systemUser("none", [], perms, hash, password);
  const only = {};
  const allBut = {};
  for (const s of slugs) {
    only[s] = await systemUser(`only_${s}`, [s], perms, hash, password);
    allBut[s] = await systemUser(`allbut_${s}`, slugs.filter((x) => x !== s), perms, hash, password);
  }

  let before = failed;
  for (const r of routes) {
    const res = await call(r.method, r.path, companyToken, {});
    if (SYSTEM_ONLY.has(r.permission)) assert(`company token: ${r.method} ${r.path} → 403 (system only)`, isPermissionDenial(res), `${res.status} ${res.data?.message}`);
    else assert(`company token: ${r.method} ${r.path} is not refused`, !isAuthFailure(res), `${res.status} ${res.data?.message}`);
  }
  section(`company token passes protect + permission on every company route, 403 on the ${SYSTEM_ONLY.size} system-only one(s)`, before);

  // GET /auth/me reports what the gate actually allows (close-out #4) — the
  // frontend gates on this list with no company special case
  before = failed;
  const me = await call("GET", "/auth/me", companyToken);
  const mine = me.data?.data?.user?.role?.permissions || [];
  assert("company /auth/me: every company V2 route permission is listed", companySlugs.every((s) => mine.includes(s)), companySlugs.filter((s) => !mine.includes(s)));
  assert("company /auth/me: no system-only permission listed", [...SYSTEM_ONLY].every((s) => !mine.includes(s)), mine);
  assert("company /auth/me: nothing listed that the gate refuses (except the read_dashboard landing page)", mine.every((s) => s === "read_dashboard" || COMPANY_ALLOWED_MODULES.includes(permissionModule(s))), mine.filter((s) => s !== "read_dashboard" && !COMPANY_ALLOWED_MODULES.includes(permissionModule(s))));
  assert("company /auth/me: no stale hard-coded slug (manage_company_brands)", !mine.includes("manage_company_brands"), mine);
  const seeded = (await prisma.permission.findMany({ select: { slug: true } })).map((p) => p.slug);
  assert("company /auth/me: every listed slug exists in the permissions table", mine.every((s) => seeded.includes(s)), mine.filter((s) => !seeded.includes(s)));
  section("company /auth/me lists exactly its effective permissions", before);

  before = failed;
  for (const r of routes) {
    const res = await call(r.method, r.path, only[r.permission], {});
    assert(`only ${r.permission}: ${r.method} ${r.path} is allowed`, !isAuthFailure(res), `${res.status} ${res.data?.message}`);
  }
  section("a system user with just the route's permission is let through on every route", before);

  before = failed;
  for (const r of routes) {
    const res = await call(r.method, r.path, allBut[r.permission], {});
    assert(`all but ${r.permission}: ${r.method} ${r.path} → 403`, isPermissionDenial(res), `${res.status} ${res.data?.message}`);
  }
  section("a system user with every other V2 permission is refused (403) on every route", before);

  before = failed;
  for (const r of routes) {
    const res = await call(r.method, r.path, noneToken, {});
    assert(`no permissions: ${r.method} ${r.path} → 403`, isPermissionDenial(res), `${res.status} ${res.data?.message}`);
  }
  section("a system user without permissions is refused (403) on every route", before);

  before = failed;
  for (const r of routes) {
    const res = await fetch(`${BASE_URL}${fill(r.path)}`, { method: r.method, headers: { "x-force-auth": "true" } });
    assert(`no token: ${r.method} ${r.path} → 401`, res.status === 401, res.status);
  }
  section("no token → 401 on every route", before);

  before = failed;
  const forged = companyToken.slice(0, -4) + (companyToken.endsWith("AAAA") ? "BBBB" : "AAAA");
  for (const r of routes.slice(0, 5)) {
    const res = await call(r.method, r.path, forged, {});
    assert(`tampered token: ${r.method} ${r.path} → 401`, res.status === 401, res.status);
  }
  const bt = await call("GET", `/background-tasks/${FAKE}`, companyToken);
  assert("background task (protect only) with a company token → 404, not 401/403", bt.status === 404, bt.status);
  section("tampered tokens are refused; the task route is authenticated", before);
}

async function cleanup() {
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.role.deleteMany({ where: { id: { in: created.roles } } });
  await prisma.company.deleteMany({ where: { id: { in: created.companies } } });
  await prisma.$disconnect();
}

run()
  .catch((err) => {
    console.error("Fatal:", err);
    failed++;
  })
  .finally(async () => {
    await cleanup();
    console.log(`\n📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total\n`);
    process.exit(failed > 0 ? 1 : 0);
  });
