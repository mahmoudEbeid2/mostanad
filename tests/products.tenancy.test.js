// Products are tenant-scoped for company callers (review finding #2): list,
// read, update, delete and every create path. Another tenant's product is a
// 404 (never 403) and is left untouched; a ?companyId= naming another company
// is ignored. System users keep the global view. Needs `npm run dev:test`.
import { prisma } from "../src/lib/prisma.js";
import { BYPASS } from "./testBypass.js";

const BASE_URL = "http://127.0.0.1:3000/api/v1";

let passed = 0;
let failed = 0;
function assert(label, condition, details = "") {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}${details ? `\n     → ${typeof details === "string" ? details : JSON.stringify(details)}` : ""}`);
    failed++;
  }
}

const asCompany = (id) => ({ "x-test-bypass": BYPASS, "x-bypass-type": "company", "x-bypass-id": id });
const asAdmin = { "x-test-bypass": BYPASS };

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
  } catch (_) {
    data = null; // 204 / non-JSON body
  }
  return { status: res.status, data };
}

const ts = Date.now();
const companies = [];

async function run() {
  console.log("\n🧪 Products — tenancy for company callers");
  const [coA, coB] = await Promise.all(
    ["a", "b"].map((s) => prisma.company.create({ data: { name: `PT ${s} ${ts}`, username: `pt_${s}_${ts}`, password: "x", email: `pt_${s}_${ts}@example.com` } }))
  );
  companies.push(coA.id, coB.id);
  const A = asCompany(coA.id);
  const pA = await prisma.product.create({ data: { companyId: coA.id, name: `A product ${ts}` } });
  const pB = await prisma.product.create({ data: { companyId: coB.id, name: `B product ${ts}` } });

  // list
  let r = await call("GET", `/products?limit=100&search=${ts}`, A);
  let ids = (r.data?.data?.products || []).map((p) => p.id);
  assert("list → only the caller's products", r.status === 200 && ids.includes(pA.id) && !ids.includes(pB.id), ids);
  r = await call("GET", `/products?limit=100&search=${ts}&companyId=${coB.id}`, A);
  ids = (r.data?.data?.products || []).map((p) => p.id);
  assert("?companyId=<other tenant> is ignored", r.status === 200 && ids.includes(pA.id) && !ids.includes(pB.id), ids);
  r = await call("GET", `/products?limit=100&search=${ts}`, asAdmin);
  ids = (r.data?.data?.products || []).map((p) => p.id);
  assert("a system user still sees every tenant", r.status === 200 && ids.includes(pA.id) && ids.includes(pB.id), ids);
  r = await call("GET", `/products?limit=100&search=${ts}&companyId=${coB.id}`, asAdmin);
  ids = (r.data?.data?.products || []).map((p) => p.id);
  assert("a system user may filter with ?companyId=", r.status === 200 && ids.length === 1 && ids[0] === pB.id, ids);
  const row = r.data.data.products[0];
  assert("list rows name their company (id + name only, nothing else of the company)", row.company?.id === coB.id && !!row.company.name && Object.keys(row.company).sort().join() === "id,name", row.company);

  // by id
  r = await call("GET", `/products/${pA.id}`, A);
  assert("GET own product → 200", r.status === 200 && r.data?.data?.product?.id === pA.id, r.status);
  r = await call("GET", `/products/${pB.id}`, A);
  assert("GET another tenant's product → 404", r.status === 404, r.status);
  r = await call("PATCH", `/products/${pB.id}`, A, { name: "hijacked" });
  assert("PATCH another tenant's product → 404", r.status === 404, r.status);
  r = await call("DELETE", `/products/${pB.id}`, A);
  assert("DELETE another tenant's product → 404", r.status === 404, r.status);
  const still = await prisma.product.findUnique({ where: { id: pB.id } });
  assert("…and it is untouched", still?.name === `B product ${ts}`, still?.name);
  r = await call("PATCH", `/products/${pA.id}`, A, { name: `A renamed ${ts}` });
  assert("PATCH own product → 200", r.status === 200 && r.data?.data?.product?.name === `A renamed ${ts}`, r.status);

  // create paths
  r = await call("POST", "/products", A, { companyId: coB.id, name: `planted ${ts}` });
  assert("POST /products into another tenant → 404", r.status === 404, r.status);
  r = await call("POST", "/products/extract-ai", A, { companyId: coB.id, rawText: "x" });
  assert("POST /products/extract-ai into another tenant → 404", r.status === 404, r.status);
  const form = new FormData();
  form.append("catalog", new Blob([Buffer.from("%PDF-1.4\n%%EOF")], { type: "application/pdf" }), "c.pdf");
  form.append("companyId", coB.id);
  r = await call("POST", "/products/upload-catalog", A, form);
  assert("POST /products/upload-catalog into another tenant → 404", r.status === 404, r.status);
  const planted = await prisma.product.count({ where: { companyId: coB.id } });
  const tasks = await prisma.backgroundTask.count({ where: { companyId: coB.id } });
  assert("nothing was created or queued for the other tenant", planted === 1 && tasks === 0, { planted, tasks });
  r = await call("POST", "/products", A, { companyId: coA.id, name: `own ${ts}` });
  assert("POST /products into the caller's own company → 201", r.status === 201 && r.data?.data?.product?.companyId === coA.id, r.status);

  r = await call("DELETE", `/products/${pA.id}`, A);
  assert("DELETE own product → 204", r.status === 204, r.status);
}

async function cleanup() {
  await prisma.backgroundTask.deleteMany({ where: { companyId: { in: companies } } });
  await prisma.product.deleteMany({ where: { companyId: { in: companies } } });
  await prisma.company.deleteMany({ where: { id: { in: companies } } });
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
