// POST /reference-labels with several files (client report 24 Nov: "task is
// not defined" after the upload moved into queueReferenceLabel). Every file
// gets its own result: queued with a taskId, skipped because the same company
// already has that same FILE as a reference (its content, not its name — with the
// date), or failed. Another company's copy of the file is not a duplicate. A company caller always
// uploads into its own company (here and on POST /eda-requirements). Needs `npm run dev:test`.
import crypto from "crypto";
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
    data = null; // non-JSON body
  }
  return { status: res.status, data };
}

const ts = Date.now();
const companies = [];
// A tiny valid PNG — the worker never reads it here (Gemini is off in tests).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// each named file has its own bytes (the PNG + its name after IEND): a duplicate is the same content
const bytesOf = (name) => Buffer.concat([PNG, Buffer.from(name)]);
const sha = (name) => crypto.createHash("sha256").update(bytesOf(name)).digest("hex");
function form(names, fields = {}) {
  const f = new FormData();
  for (const n of names) f.append("files", new Blob([bytesOf(n)], { type: "image/png" }), n);
  f.append("country", "Egypt");
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

async function run() {
  console.log("\n🧪 Reference labels — multi-file upload");
  const [coA, coB] = await Promise.all(
    ["a", "b"].map((s) => prisma.company.create({ data: { name: `RL ${s} ${ts}`, username: `rl_${s}_${ts}`, password: "x", email: `rl_${s}_${ts}@example.com` } }))
  );
  companies.push(coA.id, coB.id);
  const one = `one-${ts}.png`;
  const two = `two-${ts}.png`;

  // two files through the route → 202 and two distinct taskIds
  let r = await call("POST", "/reference-labels", asAdmin, form([one, two], { companyId: coA.id }));
  const tasks = r.data?.data?.tasks || [];
  assert("2 files → 202", r.status === 202, { status: r.status, body: r.data });
  assert("2 files → two taskIds, one per file", tasks.length === 2 && tasks.every((t) => typeof t.taskId === "string") && new Set(tasks.map((t) => t.taskId)).size === 2 && tasks.map((t) => t.fileName).sort().join() === [one, two].sort().join(), tasks);
  const rows = await prisma.backgroundTask.findMany({ where: { id: { in: tasks.map((t) => t.taskId) } } });
  assert("both tasks exist for the chosen company", rows.length === 2 && rows.every((t) => t.companyId === coA.id && t.type === "reference_label_extraction"), rows.map((t) => t.companyId));

  // a file company A already has is skipped, with the date; the other file is queued
  const existing = await prisma.referenceLabel.create({ data: { name: one, companyId: coA.id, country: "Egypt", sourceSha256: sha(one), createdAt: new Date("2026-11-20T10:00:00Z") } });
  r = await call("POST", "/reference-labels", asAdmin, form([one, two], { companyId: coA.id }));
  const skipped = r.data?.data?.skipped || [];
  assert("duplicate in the same company → skipped with its date, the other queued", r.status === 202 && r.data.data.tasks.length === 1 && r.data.data.tasks[0].fileName === two && skipped.length === 1 && skipped[0].fileName === one && skipped[0].existingId === existing.id, r.data);
  assert("the message names the skipped file and when it was uploaded", /one-\d+\.png \(the same file was already uploaded on 2026-11-20\)/.test(r.data?.message || ""), r.data?.message);

  // the same file in another company is not a duplicate
  r = await call("POST", "/reference-labels", asAdmin, form([one], { companyId: coB.id }));
  assert("same file, another company → queued", r.status === 202 && r.data.data.tasks.length === 1 && (r.data.data.skipped || []).length === 0, r.data);

  // every file a duplicate → 400 that says which and when
  r = await call("POST", "/reference-labels", asAdmin, form([one], { companyId: coA.id }));
  assert("all duplicates → 400 naming the file and date", r.status === 400 && /one-\d+\.png \(the same file was already uploaded on 2026-11-20\)/.test(r.data?.message || ""), r.data);
  assert("…with the per-file lists for the upload screen", r.data?.data?.tasks?.length === 0 && r.data.data.skipped?.[0]?.fileName === one && r.data.data.skipped[0].uploadedAt, r.data);

  // a company caller cannot upload into another company
  r = await call("POST", "/reference-labels", asCompany(coA.id), form([`three-${ts}.png`], { companyId: coB.id }));
  const own = r.data?.data?.tasks?.[0]?.taskId && (await prisma.backgroundTask.findUnique({ where: { id: r.data.data.tasks[0].taskId } }));
  assert("company caller naming another company → its own company", r.status === 202 && own?.companyId === coA.id, { status: r.status, companyId: own?.companyId });

  // the other upload that queues a task from a controller: EDA requirements
  const doc = () => {
    const f = new FormData();
    f.append("file", new Blob([Buffer.from("%PDF-1.4\n%%EOF\n")], { type: "application/pdf" }), `rules-${ts}.pdf`);
    f.append("companyId", coB.id);
    return f;
  };
  r = await call("POST", "/eda-requirements", asAdmin, doc());
  let eda = r.data?.data?.jobId && (await prisma.backgroundTask.findUnique({ where: { id: r.data.data.jobId } }));
  assert("POST /eda-requirements → 202 with the task of the named company", r.status === 202 && eda?.companyId === coB.id, { status: r.status, body: r.data });
  r = await call("POST", "/eda-requirements", asCompany(coA.id), doc());
  eda = r.data?.data?.jobId && (await prisma.backgroundTask.findUnique({ where: { id: r.data.data.jobId } }));
  assert("POST /eda-requirements as a company naming another → its own company", r.status === 202 && eda?.companyId === coA.id, { status: r.status, companyId: eda?.companyId });

  // same bug class: POST /products/extract-ai used AppError without importing it
  r = await call("POST", "/products/extract-ai", asAdmin, { companyId: coA.id });
  assert("POST /products/extract-ai without rawText → 400, not a crash", r.status === 400, { status: r.status, body: r.data });
}

async function cleanup() {
  await prisma.referenceLabel.deleteMany({ where: { companyId: { in: companies } } });
  await prisma.backgroundTask.deleteMany({ where: { companyId: { in: companies } } });
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
