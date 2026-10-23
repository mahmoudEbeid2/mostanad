// Certificate AI layers — Phase A6.1 (plan.md §15.2, §15.7): the product catalogue
// is kept as a source document.
// Proven here:
//  - code segmentation of the Agrikima sample: every product block found (29), each
//    printed code inside its own block, no text from a neighbouring product
//  - upload → StoredFile kept (same bytes, sha256), version + blocks with page/bbox/text/lines;
//    the daily orphan sweep never deletes a catalogue file
//  - tenancy: another company gets 404 on the catalogue, version, block and file
//  - linking a block writes the product's catalogueRef and nothing else
//  - re-segmenting is idempotent and refused once blocks are linked
//  - manage_catalogues: system users only (real JWTs — a company token is refused, reads work)
//  - the legacy /products/upload-catalog route still answers
// Needs the guarded stack (npm run dev:test). No AI call anywhere in A6.1.
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { api, asAdmin, asCompany, makeAssert, finish, createCompany, cleanupCompany, form, pollTask, prisma, BASE_URL } from "./helpers.js";
import { readPdfLayout } from "../../src/services/catalogues/pdfLayout.js";
import { segment, headingsOf, toLines } from "../../src/services/catalogues/segmenter.js";
import { runSegmentJob } from "../../src/services/catalogues/catalogueService.js";
import { cleanupOrphanFiles, failStuckTasks } from "../../src/services/certificates/maintenance/maintenanceService.js";
import { absolutePath, sha256 } from "../../src/services/certificates/storage/fileStore.js";

const { assert, counts } = makeAssert();
const SAMPLE = path.join(process.cwd(), "fixtures", "catalogues", "Agrikima_Catalogue_2022-new_-_feed.pdf");
const pdf = fs.readFileSync(SAMPLE);

// hand-checked against the page images (A6 step-1 audit): title (null = drawn as artwork) and printed code
const EXPECTED = [
  ["Advice", null, "AKS030"], ["MIX5", "MIX5", "AKS031"], ["Toxinil", "Toxinil", "AKF029"], ["Antistrs-300", "Antistrs-300", "AKS040"],
  ["Nutritic", "NUTRITIC", "AKF007"], ["K-Digest", "K-Digest", "AKS17"], ["Re-Cover", "Re-Cover", "AKS2017015"], ["Growth 80", "Growth 80", "AKS2017014"],
  ["Immuzyme", "Immuzyme", "AKF06"], ["Optimum24", "Optimum24", "AKF41"], ["Mentholic", "Mentholic", "AKS05"], ["Agri-CalD3", "Agri-CalD3", "AKS01"],
  ["Aminovital", "Aminovital", "AKS02"], ["Calcium-70", "Calcium-70", "AKS03"], ["Agrivita+", "Agrivita+", "AKS06"], ["Agri-E+S200", "Agri-E+S200", "AKS207"],
  ["Kima-Immune", "Kima-Immune", "AKS08"], ["Agri-Hepa+", "Agri-Hepa+", "AKS09"], ["Agrilyte+C", "Agrilyte+C", "AKS11"], ["Agrivita-C", "Agrivita-C", "AKS10"],
  ["Agrizec", "Agrizec", "AKS12"], ["AD3E 100/20/20", "AD3E 100/20/20", "AKS43"], ["AD3E-CK", "AD3E-CK", "AKS13"], ["AD3E-PLUS", "AD3E-PLUS", "AKS13"],
  ["IMMUSOL", "IMMUSOL", null], ["DL-METHIONINE", "DL-METHIONINE", null], ["CHOLINE CHLORIDE 70%", "CHOLINE CHLORIDE 70%", null], ["THERIONINE 65%", "THERIONINE 65%", null], ["BETAINE 50%", "BETAINE 50%", null],
];
const CODE_RE = /\b(AK[SF]\d{2,7})\b/g;

const co = await createCompany("a6a");
const coB = await createCompany("a6b");
const A = asCompany(co.id);
const B = asCompany(coB.id);
const created = { roles: [], users: [] };

async function segmentation() {
  console.log("\n🧩 Segmentation of the Agrikima sample (code only)");
  const layout = await readPdfLayout(pdf);
  const { blocks, warnings, stats } = segment(layout);
  const products = blocks.filter((b) => b.kind === "product");
  assert("18 pages read", layout.pages.length === 18, layout.pages.length);
  assert("every product block found: 29 (plan: segmentation errors ≤ 1)", products.length === EXPECTED.length, products.length);
  assert("no warnings on a live-text catalogue", warnings.length === 0, warnings);
  assert("cover, welcome and back pages are context blocks", stats.context === 4 && blocks.filter((b) => b.kind === "context").every((b) => [1, 2, 18].includes(b.page)), blocks.filter((b) => b.kind === "context").map((b) => b.page));
  let ordered = true;
  let codesOwn = true;
  let titles = true;
  for (const [i, [name, title, code]] of EXPECTED.entries()) {
    const b = products[i];
    if (!b) { ordered = false; continue; }
    if (b.title !== title) titles = false;
    const codes = [...b.text.matchAll(CODE_RE)].map((m) => m[1]);
    // each block carries exactly its own printed code (or none, when the catalogue prints none)
    if (code ? codes.length !== 1 || codes[0] !== code : codes.length !== 0) codesOwn = false;
    if (!b.text.toLowerCase().includes(name.toLowerCase().split(" ")[0])) ordered = false;
  }
  assert("blocks in catalogue order, each naming its product", ordered);
  assert("large-font titles found (Advice's is artwork → null)", titles, products.map((b) => b.title));
  assert("each printed code is inside its own block and in no other", codesOwn, products.map((b) => [...b.text.matchAll(CODE_RE)].map((m) => m[1])));
  const toxinil = products[2];
  assert("Toxinil's block holds none of Advice's text (the storage bleed of the V1 run)", !/original packing/i.test(toxinil.text) && /Store in a cool and dry place/.test(toxinil.text));
  const agrizec = products[20];
  assert("a composition row keeps its name and value on one line", agrizec.text.includes("Vitamin E\t200.000 mg") && agrizec.text.includes("Vitamin A\t100000 I.U."));
  assert("Calcium-70 keeps its raw numbers", products[13].text.includes("Calcium Chloride\t70.000 mg") && products[13].text.includes("Distillate water up to\t1.000 mL"));
  assert("AD3E keeps space-grouped numbers", products[21].text.includes("100 000 000 I.U."));
  assert("Betaine's SPECIFICATIONS table rows stay rows", products[28].text.includes("Assay, %\t≥\t50"));
  const linesOk = products.every((b) => b.lines.every((l) => b.text.slice(l.o, l.o + l.t.length) === l.t && l.w >= 0 && l.h > 0));
  assert("every line's offset points at its text in the block", linesOk);
  assert("every block has a page and a bbox inside its page", products.every((b) => { const p = layout.pages[b.page - 1]; return b.bbox.x >= 0 && b.bbox.x + b.bbox.w <= p.width + 1 && b.bbox.y + b.bbox.h <= p.height + 1; }));

  // synthetic layouts: scanned page, portrait page with two products, headings
  const it = (s, x, y, h = 8) => ({ s, x, y, w: s.length * 4, h });
  const synth = segment({
    pages: [
      { n: 1, width: 595, height: 842, items: [] },
      { n: 2, width: 595, height: 842, items: [it("Alpha", 40, 40, 30), it("COMPOSITION", 40, 90), it("x 1 mg", 40, 100), it("DOSAGE", 40, 120), it("1 g", 40, 130), it("Beta", 40, 400, 30), it("PACKING", 40, 450), it("1 L", 40, 460), it("CODE", 40, 480), it("B1", 40, 490)] },
    ],
  });
  assert("a page without a text layer is flagged no_text_layer", synth.warnings.some((w) => w.code === "no_text_layer" && w.page === 1));
  assert("two titles on one portrait page → two product blocks", synth.blocks.filter((b) => b.kind === "product").map((b) => b.title).join(",") === "Alpha,Beta", synth.blocks.map((b) => [b.kind, b.title]));
  assert("headings: upper-case only, several per line", headingsOf("FORM\tCODE").join() === "FORM,CODE" && headingsOf("Dosage").length === 0 && headingsOf("PRECAUTIONS!").join() === "PRECAUTIONS");
  assert("lines: same baseline, left to right → one tab-joined line", toLines([it("Vitamin E", 40, 100), it("200.000 mg", 150, 100), it("Selenium", 40, 110)]).map((l) => l.t).join("|") === "Vitamin E\t200.000 mg|Selenium");
}

let versionId = null;
let catalogueId = null;
let blocks = [];

async function upload() {
  console.log("\n📤 Upload → kept file, version, blocks");
  let r = await api("POST", "/catalogues", asAdmin, form({ manufacturer: "Agrikima Sdn. Bhd.", label: "2025–2026" }, { buffer: pdf, name: "agrikima.pdf", type: "application/pdf" }));
  assert("no company → 400 COMPANY_REQUIRED (the admin must pick one)", r.status === 400 && r.data?.code === "COMPANY_REQUIRED", r);
  r = await api("POST", "/catalogues", asAdmin, form({ companyId: co.id }, { buffer: Buffer.from("not a pdf"), name: "x.pdf" }));
  assert("a non-PDF → 415 NOT_A_PDF", r.status === 415 && r.data?.code === "NOT_A_PDF", r.status);
  const brandB = await prisma.brand.create({ data: { companyId: coB.id, name: "Other" } });
  r = await api("POST", "/catalogues", asAdmin, form({ companyId: co.id, brandId: brandB.id }, { buffer: pdf, name: "a.pdf", type: "application/pdf" }));
  assert("another company's brand → 400 BRAND_NOT_IN_COMPANY", r.status === 400 && r.data?.code === "BRAND_NOT_IN_COMPANY", r.status);

  const before = await prisma.product.count();
  r = await api("POST", "/catalogues", asAdmin, form({ companyId: co.id, manufacturer: "Agrikima Sdn. Bhd.", label: "2025–2026" }, { buffer: pdf, name: "Agrikima_Catalogue_2022-new_-_feed.pdf", type: "application/pdf" }));
  assert("upload → 202 with catalogue, version and job ids", r.status === 202 && r.data?.data?.versionId && r.data?.data?.jobId, r);
  ({ versionId, catalogueId } = r.data.data);
  const task = await pollTask(r.data.data.jobId, asAdmin, { timeoutMs: 60_000 });
  assert("segment task completed", task?.status === "completed", task);
  assert("task result: 29 product blocks, 18 pages", task?.result?.productBlocks === 29 && task?.result?.pages === 18, task?.result);

  const version = await prisma.catalogueVersion.findUnique({ where: { id: versionId } });
  assert("version segmented, 18 pages, segmenter recorded", version.status === "segmented" && version.pages === 18 && version.extraction?.segmenter, version);
  const file = await prisma.storedFile.findUnique({ where: { id: version.sourceFileId } });
  assert("the file is a StoredFile of the company, kind catalogue_source", file?.companyId === co.id && file.kind === "catalogue_source" && file.originalName === "Agrikima_Catalogue_2022-new_-_feed.pdf");
  assert("kept byte for byte (sha256)", file.sha256 === sha256(pdf) && fs.readFileSync(absolutePath(file)).equals(pdf));
  blocks = await prisma.catalogueBlock.findMany({ where: { versionId }, orderBy: { seq: "asc" } });
  assert("33 blocks stored (29 product + 4 context), each with page, bbox, text and lines", blocks.length === 33 && blocks.every((b) => b.page >= 1 && b.bbox?.w > 0 && b.text && Array.isArray(b.lines) && b.lines.length), blocks.length);
  assert("blocks carry the company (tenant scope without a join)", blocks.every((b) => b.companyId === co.id));
  assert("no product was created or changed by an upload", (await prisma.product.count()) === before);

  // a second upload from the same manufacturer is a new version of the same catalogue
  r = await api("POST", `/catalogues/${catalogueId}/versions`, asAdmin, form({ label: "reprint" }, { buffer: pdf, name: "again.pdf", type: "application/pdf" }));
  assert("POST /catalogues/:id/versions → 202, same catalogue", r.status === 202 && r.data?.data?.catalogueId === catalogueId, r);
  await pollTask(r.data.data.jobId, asAdmin);
  r = await api("POST", "/catalogues", asAdmin, form({ companyId: co.id, manufacturer: "Agrikima Sdn. Bhd." }, { buffer: pdf, name: "third.pdf", type: "application/pdf" }));
  assert("upload with the same manufacturer → a version of the same catalogue", r.data?.data?.catalogueId === catalogueId);
  await pollTask(r.data.data.jobId, asAdmin);
  assert("the company has one catalogue with three versions", (await prisma.catalogueVersion.count({ where: { catalogueId } })) === 3 && (await prisma.catalogue.count({ where: { companyId: co.id } })) === 1);
}

async function reads() {
  console.log("\n🔒 Reads and tenancy");
  let r = await api("GET", "/catalogues", A);
  assert("company A lists its catalogue with its versions", r.status === 200 && r.data.data.catalogues.length === 1 && r.data.data.catalogues[0].versions.length === 3, r.data);
  r = await api("GET", "/catalogues", B);
  assert("company B lists nothing", r.status === 200 && r.data.data.catalogues.length === 0);
  r = await api("GET", `/catalogues?companyId=${co.id}`, asAdmin);
  assert("a system user lists a chosen company's catalogues", r.status === 200 && r.data.data.catalogues.length === 1);
  r = await api("GET", `/catalogue-versions/${versionId}`, A);
  assert("version with its 33 blocks (no geometry in the list)", r.status === 200 && r.data.data.version.blocks.length === 33 && r.data.data.version.blocks[0].lines === undefined);
  const block = blocks.find((b) => b.kind === "product");
  r = await api("GET", `/catalogue-blocks/${block.id}`, A);
  assert("a block with text and line geometry", r.status === 200 && r.data.data.block.text === block.text && r.data.data.block.lines.length === block.lines.length);
  r = await api("GET", `/catalogue-versions/${versionId}/file`, A);
  assert("the kept PDF streams back unchanged", r.status === 200 && r.headers.get("content-type") === "application/pdf" && r.buffer.equals(pdf));
  for (const [what, url] of [["catalogue", `/catalogues/${catalogueId}`], ["version", `/catalogue-versions/${versionId}`], ["block", `/catalogue-blocks/${block.id}`], ["file", `/catalogue-versions/${versionId}/file`]]) {
    r = await api("GET", url, B);
    assert(`another company → 404 on the ${what}`, r.status === 404, r.status);
  }
}

async function keptForever() {
  console.log("\n🗄️ The catalogue file is never swept");
  const version = await prisma.catalogueVersion.findUnique({ where: { id: versionId } });
  const file = await prisma.storedFile.findUnique({ where: { id: version.sourceFileId } });
  const res = await cleanupOrphanFiles({ olderThanHours: 1, now: new Date(Date.now() + 72 * 3600_000), companyId: co.id });
  assert("the orphan sweep (3 days later) scanned the company's files", res.scanned >= 3, res);
  assert("…and deleted none of them (catalogue_versions.source_file_id is a reference)", res.deleted === 0 && fs.existsSync(absolutePath(file)), res);
}

async function linking() {
  console.log("\n🔗 Linking a block to a product");
  const product = await prisma.product.create({ data: { companyId: co.id, name: "Agrizec", storage: "Keep cold", activeIngredients: [{ name: "Vitamin E", concentration: "200 g/L" }] } });
  const productB = await prisma.product.create({ data: { companyId: coB.id, name: "Agrizec" } });
  const agrizec = blocks.find((b) => b.title === "Agrizec");
  const context = blocks.find((b) => b.kind === "context");
  const before = await prisma.product.findUnique({ where: { id: product.id } });
  let r = await api("POST", `/catalogue-blocks/${agrizec.id}/link`, asAdmin, { productId: product.id });
  assert("link → 200 with the catalogueRef", r.status === 200 && r.data.data.catalogueRef?.blockId === agrizec.id && r.data.data.catalogueRef.page === agrizec.page && r.data.data.catalogueRef.catalogueVersionId === versionId, r.data);
  const after = await prisma.product.findUnique({ where: { id: product.id } });
  const strip = (p) => JSON.stringify({ ...p, catalogueRef: null, updatedAt: null });
  assert("product.catalogueRef written; every other field unchanged", after.catalogueRef?.blockId === agrizec.id && strip(after) === strip(before));
  assert("block.productId set", (await prisma.catalogueBlock.findUnique({ where: { id: agrizec.id } })).productId === product.id);
  r = await api("POST", `/catalogue-blocks/${agrizec.id}/link`, asAdmin, { productId: productB.id });
  assert("another company's product → 404", r.status === 404, r.status);
  r = await api("POST", `/catalogue-blocks/${context.id}/link`, asAdmin, { productId: product.id });
  assert("a context block can't be linked → 409", r.status === 409 && r.data?.code === "NOT_A_PRODUCT_BLOCK", r.data);

  // re-segmenting: idempotent while untouched, refused once linked (and the version stays as it was)
  const other = await prisma.catalogueVersion.findFirst({ where: { catalogueId, NOT: { id: versionId } } });
  const res = await runSegmentJob(other.id);
  assert("re-segmenting an untouched version → the same 33 blocks", res.productBlocks === 29 && (await prisma.catalogueBlock.count({ where: { versionId: other.id } })) === 33);
  let err = null;
  try {
    await runSegmentJob(versionId);
  } catch (e) {
    err = e;
  }
  const v = await prisma.catalogueVersion.findUnique({ where: { id: versionId } });
  assert("re-segmenting a linked version → BLOCKS_IN_USE, version untouched", err?.code === "BLOCKS_IN_USE" && v.status === "segmented" && (await prisma.catalogueBlock.count({ where: { versionId } })) === 33, err?.message);

  // a stuck segmentation is released by the daily job
  await prisma.catalogueVersion.update({ where: { id: other.id }, data: { status: "segmenting" } });
  await prisma.$executeRaw`UPDATE catalogue_versions SET updated_at = now() - interval '2 hours' WHERE id = ${other.id}`;
  const stuck = await failStuckTasks({ companyId: co.id, queueNames: [] });
  assert("a version stuck in segmenting → failed by the daily job", stuck.catalogueVersions === 1 && (await prisma.catalogueVersion.findUnique({ where: { id: other.id } })).status === "failed", stuck);
}

// real tokens, no bypass header — restrictToPermission runs as in production
async function login(url, username, password) {
  const res = await fetch(`${BASE_URL}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  const body = await res.json();
  if (!body?.data?.token) throw new Error(`login ${url} → ${res.status}`);
  return body.data.token;
}
async function call(method, url, token, body) {
  const headers = { Authorization: `Bearer ${token}`, "x-force-auth": "true" };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${url}`, { method, headers, body: payload });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = { nonJson: e.message };
  }
  return { status: res.status, data };
}
const denied = (r) => r.status === 403 && /permission/i.test(r.data?.message || "");

async function permissions() {
  console.log("\n🪪 manage_catalogues — real JWTs");
  const ts = Date.now();
  const password = `Pw-${ts}-x`;
  const hash = await bcrypt.hash(password, 10);
  await prisma.company.update({ where: { id: co.id }, data: { password: hash } });
  const companyToken = await login("/companies/login", co.username, password);
  const perm = await prisma.permission.findUnique({ where: { slug: "manage_catalogues" } });
  const readProducts = await prisma.permission.findUnique({ where: { slug: "read_products" } });
  assert("manage_catalogues is seeded", !!perm);
  const user = async (label, perms) => {
    const role = await prisma.role.create({ data: { name: `a6_${label}_${ts}`, permissions: { create: perms.map((p) => ({ permissionId: p.id })) } } });
    created.roles.push(role.id);
    const username = `a6_${label}_${ts}`;
    const u = await prisma.user.create({ data: { name: username, username, email: `${username}@example.invalid`, password: hash, roleId: role.id } });
    created.users.push(u.id);
    return login("/auth/login", username, password);
  };
  const manager = await user("manager", [perm]);
  const reader = await user("reader", [readProducts]);
  const block = blocks.find((b) => b.kind === "product");
  const pdfForm = () => form({ companyId: co.id }, { buffer: pdf, name: "p.pdf", type: "application/pdf" });

  assert("company token: upload refused (403)", denied(await call("POST", "/catalogues", companyToken, pdfForm())));
  assert("company token: new version refused (403)", denied(await call("POST", `/catalogues/${catalogueId}/versions`, companyToken, pdfForm())));
  assert("company token: link refused (403)", denied(await call("POST", `/catalogue-blocks/${block.id}/link`, companyToken, { productId: block.id })));
  let r = await call("GET", "/catalogues", companyToken);
  assert("company token: reads its catalogues (200)", r.status === 200 && r.data.data.catalogues.length === 1);
  assert("system user without manage_catalogues: upload refused (403)", denied(await call("POST", "/catalogues", reader, pdfForm())));
  r = await call("POST", "/catalogues", manager, pdfForm());
  assert("system user with manage_catalogues: upload accepted (202)", r.status === 202, r);
  if (r.data?.data?.jobId) await pollTask(r.data.data.jobId, asAdmin);
  const { COMPANY_ALLOWED_MODULES, permissionModule } = await import("../../src/middleware/authMiddleware.js");
  assert("its module is not company-allowed", !COMPANY_ALLOWED_MODULES.includes(permissionModule("manage_catalogues")));
}

async function legacy() {
  console.log("\n🧓 The V1 catalog route still answers (§15.8: until A6 is live)");
  const r = await api("POST", "/products/upload-catalog", asAdmin, form({ companyId: co.id }));
  assert("POST /products/upload-catalog without a file → 400 (route alive)", r.status === 400, r.status);
}

try {
  await segmentation();
  await upload();
  await reads();
  await keptForever();
  await linking();
  await permissions();
  await legacy();
} catch (e) {
  assert(`suite crashed: ${e.message}`, false, e.stack);
}

await finish(counts, async () => {
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.rolePermission.deleteMany({ where: { roleId: { in: created.roles } } });
  await prisma.role.deleteMany({ where: { id: { in: created.roles } } });
  await cleanupCompany(co.id);
  await cleanupCompany(coB.id);
});
