import { BYPASS } from "../testBypass.js";
// Shared helpers for tests/certificates-v2/*. Same conventions as the other
// suites: live API on :3000 with the dev bypass header; company callers use
// x-bypass-type: company so every tenant check runs as for a real token.
import fs from "fs";
import path from "path";
import { prisma } from "../../src/lib/prisma.js";

export const BASE_URL = "http://127.0.0.1:3000/api/v1";
export const FIXTURES = path.join(process.cwd(), "fixtures", "certificates");
export const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

process.env.GEMINI_DISABLED = "true"; // tests never call a paid API

export function makeAssert() {
  const counts = { passed: 0, failed: 0 };
  const assert = (label, condition, details = "") => {
    if (condition) {
      console.log(`  ✅ PASS: ${label}`);
      counts.passed++;
    } else {
      console.log(`  ❌ FAIL: ${label}${details !== "" ? `\n     → ${typeof details === "string" ? details : JSON.stringify(details)}` : ""}`);
      counts.failed++;
    }
  };
  return { assert, counts };
}

export const asCompany = (id) => ({ "x-test-bypass": BYPASS, "x-bypass-type": "company", "x-bypass-id": id });
export const asAdmin = { "x-test-bypass": BYPASS };

export async function api(method, url, headers = {}, body) {
  const opts = { method, headers: { ...headers } };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${url}`, opts);
  const type = res.headers.get("content-type") || "";
  let data = null;
  let buffer = null;
  if (type.includes("application/json")) {
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
  } else {
    buffer = Buffer.from(await res.arrayBuffer());
  }
  return { status: res.status, data, buffer, headers: res.headers };
}

export function form(fields = {}, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) fd.append(k, String(v));
  if (file) fd.append(file.field || "file", new Blob([file.buffer], { type: file.type || "application/octet-stream" }), file.name);
  return fd;
}

export async function pollTask(taskId, headers = asAdmin, { timeoutMs = 60_000 } = {}) {
  const until = Date.now() + timeoutMs;
  let task = null;
  while (Date.now() < until) {
    const r = await api("GET", `/background-tasks/${taskId}`, headers);
    task = r.data?.data;
    if (task && (task.status === "completed" || task.status === "failed")) return task;
    await new Promise((res) => setTimeout(res, 300));
  }
  return task;
}

const stamp = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

export async function createCompany(label = "cv2") {
  const s = stamp();
  return prisma.company.create({
    data: { name: `${label} ${s}`, username: `${label}_${s}`, password: "x", email: `${label}_${s}@example.com` },
  });
}

/** Removes every Certificates V2 row and file a test company owns, then the company. */
export async function cleanupCompany(companyId) {
  const tables = await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
  const has = new Set(tables.map((t) => t.table_name));
  const del = async (table, sql) => {
    if (has.has(table)) await prisma.$executeRawUnsafe(sql, companyId);
  };
  await del("certificate_versions", `DELETE FROM certificate_versions WHERE certificate_id IN (SELECT id FROM certificates WHERE company_id = $1)`);
  await del("certificate_items", `DELETE FROM certificate_items WHERE certificate_id IN (SELECT id FROM certificates WHERE company_id = $1)`);
  await del("certificates", `DELETE FROM certificates WHERE company_id = $1`);
  await del("certificate_batches", `DELETE FROM certificate_batches WHERE company_id = $1`);
  await del("invoice_items", `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = $1)`);
  await del("invoices", `DELETE FROM invoices WHERE company_id = $1`);
  await del("template_fields", `DELETE FROM template_fields WHERE version_id IN (SELECT v.id FROM template_versions v JOIN certificate_templates t ON t.id = v.template_id WHERE t.company_id = $1)`);
  await del("certificate_templates", `UPDATE certificate_templates SET active_version_id = NULL WHERE company_id = $1`);
  await del("template_versions", `DELETE FROM template_versions WHERE template_id IN (SELECT id FROM certificate_templates WHERE company_id = $1)`);
  await del("certificate_templates", `DELETE FROM certificate_templates WHERE company_id = $1`);
  await del("certificate_types", `DELETE FROM certificate_types WHERE company_id = $1`);
  const files = await prisma.storedFile.findMany({ where: { companyId } });
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(process.cwd(), "uploads", f.path));
    } catch (_) {}
  }
  await prisma.storedFile.deleteMany({ where: { companyId } });
  try {
    fs.rmdirSync(path.join(process.cwd(), "uploads", "certificates", companyId));
  } catch (_) {}
  await prisma.product.deleteMany({ where: { companyId } });
  await prisma.brand.deleteMany({ where: { companyId } });
  await prisma.backgroundTask.deleteMany({ where: { companyId } });
  await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
}

export async function finish(counts, extraCleanup) {
  try {
    if (extraCleanup) await extraCleanup();
  } finally {
    await prisma.$disconnect();
    console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
    process.exit(counts.failed > 0 ? 1 : 0);
  }
}

/** Upload a template file and wait for the convert task. → { status, data, task, version } */
export async function uploadTemplate(companyId, { file, name, certificateTypeId, brandId, country, scope = "per_product" }) {
  const buffer = fixture(file);
  const r = await api(
    "POST",
    "/certificate-templates",
    asCompany(companyId),
    form({ name: name || file, certificateTypeId, brandId, country, scope }, { buffer, name: file })
  );
  if (r.status !== 202) return { ...r };
  const task = await pollTask(r.data.data.taskId, asCompany(companyId));
  const v = await api("GET", `/template-versions/${r.data.data.versionId}`, asCompany(companyId));
  return { ...r, task, version: v.data?.data?.version };
}

export { prisma };
