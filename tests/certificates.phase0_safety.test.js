// Certificates V2 Phase 0 — tenancy and V1 safety (CERTIFICATES_V2_PLAN.md §17).
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
const created = { companies: [], tasks: [], templates: [] };

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

  // ── V1 templates enforce ownership ──────────────────────────────
  const tplB = await prisma.template.create({
    data: { name: "B tpl", type: `p0_${ts}`, companyId: coB.id, htmlContent: "<p>B</p>" },
  });
  created.templates.push(tplB.id);

  r = await call("GET", `/templates/${tplB.id}`, asCompany(coA.id));
  assert("GET another tenant's V1 template → 404", r.status === 404, `got ${r.status}`);
  r = await call("PATCH", `/templates/${tplB.id}`, asCompany(coA.id), { name: "hijacked" });
  assert("PATCH another tenant's V1 template → 404", r.status === 404, `got ${r.status}`);
  r = await call("DELETE", `/templates/${tplB.id}`, asCompany(coA.id));
  assert("DELETE another tenant's V1 template → 404", r.status === 404, `got ${r.status}`);
  const still = await prisma.template.findUnique({ where: { id: tplB.id } });
  assert("foreign template unchanged", still?.name === "B tpl", still?.name);

  r = await call("GET", `/templates/${tplB.id}`, asCompany(coB.id));
  assert("owner reads its V1 template → 200", r.status === 200, `got ${r.status}`);

  r = await call("GET", `/companies/${coB.id}/templates`, asCompany(coA.id));
  assert("list another tenant's templates by path → 404", r.status === 404, `got ${r.status}`);
  r = await call("GET", `/templates?companyId=${coB.id}`, asCompany(coA.id));
  const leaked = (r.data?.data?.templates || []).some((t) => t.companyId === coB.id);
  assert("?companyId= override ignored for company callers", r.status === 200 && !leaked, `got ${r.status}`);

  r = await call("POST", `/companies/${coB.id}/templates`, asCompany(coA.id), {
    name: "xx",
    type: `p0b_${ts}`,
    htmlContent: "<p>x</p>",
  });
  assert("create a template in another tenant → 404", r.status === 404, `got ${r.status}`);

  // ── V1 generate-ai is disabled ──────────────────────────────────
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("%PDF-1.4")], { type: "application/pdf" }), 'evil"; rm -rf ~; ".ai');
  r = await call("POST", `/companies/${coA.id}/templates/generate-ai`, asCompany(coA.id), form);
  assert("generate-ai → 410 Gone", r.status === 410, `got ${r.status}`);
  const aiTasks = await prisma.backgroundTask.count({
    where: { companyId: coA.id, type: "ai_template_generation" },
  });
  assert("generate-ai queued nothing", aiTasks === 0, `${aiTasks} tasks`);

  // ── V1 certificate generation enforces ownership ────────────────
  const inv = new FormData();
  inv.append("invoice", new Blob([Buffer.from("%PDF-1.4\n%%EOF")], { type: "application/pdf" }), "invoice.pdf");
  inv.append("transactionType", "shipping");
  r = await call("POST", `/companies/${coB.id}/certificates/generate`, asCompany(coA.id), inv);
  assert("generate certificates for another tenant → 404", r.status === 404, `got ${r.status}`);
  const certTasks = await prisma.backgroundTask.count({ where: { companyId: coB.id, type: "certificate_generation" } });
  assert("no task created for the foreign tenant", certTasks === 0, `${certTasks} tasks`);
}

async function cleanup() {
  await prisma.template.deleteMany({ where: { id: { in: created.templates } } });
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
