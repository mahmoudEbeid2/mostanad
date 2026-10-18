// Certificates V2 Phase 0 — tenancy and V1 safety (CERTIFICATES_V2_PLAN.md §17);
// since Phase 8, V1 retirement (its routes are 404, its tables remain).
// Company callers use the dev bypass as a company (x-bypass-type: company), so
// req.company is set and every scope check runs exactly as for a real token.
import { prisma } from "../src/lib/prisma.js";

const BASE_URL = "http://127.0.0.1:3000/api/v1";

let passed = 0;
let failed = 0;
function assert(label, condition, details = "") {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}${details ? `\n     → ${details}` : ""}`);
    failed++;
  }
}

const asCompany = (id) => ({
  "x-test-bypass": "supersecretbypass",
  "x-bypass-type": "company",
  "x-bypass-id": id,
});
const asAdmin = { "x-test-bypass": "supersecretbypass" };

async function call(method, path, headers, body) {
  const opts = { method, headers: { ...headers } };
  if (body instanceof FormData) opts.body = body;
  else if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, data };
}

const ts = Date.now();
const created = { companies: [], tasks: [] };

async function run() {
  console.log("\n🧪 Certificates V2 — Phase 0 safety");

  const [coA, coB] = await Promise.all(
    ["a", "b"].map((s) =>
      prisma.company.create({
        data: { name: `P0 ${s} ${ts}`, username: `p0_${s}_${ts}`, password: "x", email: `p0_${s}_${ts}@example.com` },
      })
    )
  );
  created.companies.push(coA.id, coB.id);

  // ── Background tasks are tenant-scoped ──────────────────────────
  const taskA = await prisma.backgroundTask.create({ data: { type: "p0", status: "pending", companyId: coA.id } });
  const taskB = await prisma.backgroundTask.create({ data: { type: "p0", status: "pending", companyId: coB.id } });
  created.tasks.push(taskA.id, taskB.id);

  let r = await call("GET", `/background-tasks/${taskA.id}`, asCompany(coA.id));
  assert("company reads its own task → 200", r.status === 200 && r.data?.data?.id === taskA.id, `got ${r.status}`);
  r = await call("GET", `/background-tasks/${taskB.id}`, asCompany(coA.id));
  assert("company reads another tenant's task → 404", r.status === 404, `got ${r.status}`);
  r = await call("GET", `/background-tasks/00000000-0000-0000-0000-000000000000`, asCompany(coA.id));
  assert("missing task → 404 (same response as foreign)", r.status === 404, `got ${r.status}`);
  r = await call("GET", `/background-tasks/${taskB.id}`, asAdmin);
  assert("system user reads any task → 200", r.status === 200, `got ${r.status}`);

  // ── V1 is retired (Phase 8): its routes are gone, its tables stay ─
  // Phase 0 made these routes tenant-safe; Phase 8 removed them. Every former
  // V1 endpoint must now be a plain 404 — for a company caller and for a
  // system user alike — and must queue nothing.
  const fakeId = "00000000-0000-0000-0000-000000000000";
  const v1Routes = [
    ["GET", `/templates`],
    ["POST", `/templates`],
    ["GET", `/templates/${fakeId}`],
    ["PATCH", `/templates/${fakeId}`],
    ["DELETE", `/templates/${fakeId}`],
    ["GET", `/companies/${coA.id}/templates`],
    ["POST", `/companies/${coA.id}/templates`],
    ["POST", `/companies/${coA.id}/templates/generate-ai`],
    ["POST", `/companies/${coA.id}/certificates/generate`],
    ["POST", `/certificates/generate`],
  ];
  for (const [method, path] of v1Routes) {
    for (const [who, headers] of [["company", asCompany(coA.id)], ["system", asAdmin]]) {
      const body = method === "GET" || method === "DELETE" ? undefined : { name: "x" };
      r = await call(method, path, headers, body);
      assert(`V1 ${method} ${path.replace(coA.id, ":companyId")} (${who}) → 404`, r.status === 404, `got ${r.status}`);
    }
  }
  const v1Tasks = await prisma.backgroundTask.count({
    where: { companyId: coA.id, type: { in: ["ai_template_generation", "certificate_generation"] } },
  });
  assert("retired V1 routes queued nothing", v1Tasks === 0, `${v1Tasks} tasks`);
  const v1Table = await prisma.template.count({ where: { companyId: coA.id } });
  assert("V1 `templates` table still exists (additive rule)", v1Table === 0, String(v1Table));
}

async function cleanup() {
  await prisma.backgroundTask.deleteMany({ where: { companyId: { in: created.companies } } });
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
