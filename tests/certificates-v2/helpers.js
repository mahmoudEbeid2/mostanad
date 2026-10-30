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

/**
 * The certificate AI behaviour before "fill automatically" (owner, 2026-10-24): every AI
 * value waits for a person, no inference / web lookup unless a suite turns them on, no
 * product profile. Suites that test those confirm-first mechanics pin their companies to it.
 */
export const CONFIRM_FIRST = { fillVerifiedDirectly: false, allowProductInference: false, allowWebLookup: false, rememberProductValues: false };
export async function confirmFirst(companyId, extra = {}) {
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { aiSettings: true } });
  await prisma.company.update({ where: { id: companyId }, data: { aiSettings: { ...(c?.aiSettings || {}), ...CONFIRM_FIRST, ...extra } } });
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
  await del("certificate_data_needs", `DELETE FROM certificate_data_needs WHERE company_id = $1`);
  await del("invoice_items", `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = $1)`);
  await del("invoices", `DELETE FROM invoices WHERE company_id = $1`);
  await del("template_fields", `DELETE FROM template_fields WHERE version_id IN (SELECT v.id FROM template_versions v JOIN certificate_templates t ON t.id = v.template_id WHERE t.company_id = $1)`);
  await del("certificate_templates", `UPDATE certificate_templates SET active_version_id = NULL WHERE company_id = $1`);
  await del("template_versions", `DELETE FROM template_versions WHERE template_id IN (SELECT id FROM certificate_templates WHERE company_id = $1)`);
  await del("certificate_templates", `DELETE FROM certificate_templates WHERE company_id = $1`);
  await del("certificate_types", `DELETE FROM certificate_types WHERE company_id = $1`);
  // certificate AI layers (plan.md §4): audit rows are Restrict on the company
  await del("ai_suggestions", `DELETE FROM ai_suggestions WHERE company_id = $1`);
  await del("ai_runs", `DELETE FROM ai_runs WHERE company_id = $1`);
  // AI cost ledger: no FK (it outlives what it mentions in production), but a test's rows are scratch data
  await del("ai_calls", `DELETE FROM ai_calls WHERE company_id = $1`);
  await del("product_certificate_values", `DELETE FROM product_certificate_values WHERE company_id = $1`);
  // per-company knowledge cache rows (web facts, "came back empty") carry the company in their key
  await del("external_knowledge_cache", `DELETE FROM external_knowledge_cache WHERE kind IN ('cert_product_fact', 'cert_gap_not_found') AND lookup_key LIKE $1 || '|%'`);
  // product catalogues (plan.md §15): blocks cascade with their version; versions and catalogues are Restrict
  await del("catalogue_blocks", `DELETE FROM catalogue_blocks WHERE company_id = $1`);
  await del("catalogue_versions", `DELETE FROM catalogue_versions WHERE company_id = $1`);
  await del("catalogues", `DELETE FROM catalogues WHERE company_id = $1`);
  // data dictionary (A0), mapping memory (A1) and product aliases (A3) are company-scoped too
  await del("product_aliases", `DELETE FROM product_aliases WHERE company_id = $1`);
  await del("field_mapping_memory", `DELETE FROM field_mapping_memory WHERE company_id = $1`);
  await del("data_dictionaries", `DELETE FROM data_dictionaries WHERE company_id = $1`);
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
  await prisma.company.delete({ where: { id: companyId } }).catch((e) => {
    // already gone is fine; anything else means a table above was missed and the company leaks
    if (e.code !== "P2025") console.warn(`⚠ cleanupCompany(${companyId}) left the company behind: ${e.message.split("\n").pop()}`);
  });
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

/** C1: keep every page of a catalogue version (nothing is chosen by default). */
export async function keepAllPages(versionId) {
  const r = await api("GET", `/catalogue-versions/${versionId}/pages`, asAdmin);
  const pages = (r.data?.data?.pages || []).map((p) => p.number);
  const put = await api("PUT", `/catalogue-versions/${versionId}/page-selection`, asAdmin, { pages });
  if (put.status !== 200) throw new Error(`keepAllPages: ${put.status} ${JSON.stringify(put.data)}`);
  return pages;
}

/**
 * C1: keep every page and read them (the text and blocks an extraction starts from, no AI). For the
 * suites that work on a whole catalogue's blocks: an upload no longer reads anything.
 */
export async function readWholeCatalogue(versionId) {
  await keepAllPages(versionId);
  const { readChosenPages } = await import("../../src/services/catalogues/extraction/extractionService.js");
  await readChosenPages(await prisma.catalogueVersion.findUnique({ where: { id: versionId } }));
  await prisma.catalogueVersion.update({ where: { id: versionId }, data: { status: "segmented" } });
}

export { prisma };
