// Certificate AI layers — Phase A6.5 (plan.md §15.4, §15.8, §15.9 "Diff"; owner
// rules): a newer catalogue version is compared with the company's existing
// products and nothing changes until the admin approves, per product or per field.
// Proven on the Agrikima sample with stand-in models (no paid API):
//   v1 — an existing (pre-catalogue) product is linked retroactively: fills apply,
//        its own values are conflicts and kept unless named; AD3E-CK / AD3E-PLUS
//        (both AKS13) become two products — a duplicated code never matches.
//   v2 — the SAME file again: 0 changes, 0 new, 0 removed (estimates worded
//        differently never count; declined values are not proposed again); the
//        number convention is inherited, not asked again.
//   v3 — a copy with ONE edited composition line (Phosphoric Acid 30,000 → 50,000
//        in the PDF itself): exactly 1 changed field; a person's later edit is a
//        conflict; a product missing from the catalogue is "removed", never deleted.
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { PDFDocument, PDFName, decodePDFRawStream } from "pdf-lib";
import { api, asAdmin, asCompany, makeAssert, finish, createCompany, cleanupCompany, form, pollTask, prisma, BASE_URL } from "./helpers.js";
import { runExtractJob } from "../../src/services/catalogues/extraction/extractionService.js";

const { assert, counts } = makeAssert();
const pdf = fs.readFileSync(path.join(process.cwd(), "fixtures", "catalogues", "Agrikima_Catalogue_2022-new_-_feed.pdf"));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures", "catalogues", "agrikima.golden.json"), "utf8"));
const co = await createCompany("a6d");
const other = await createCompany("a6d2");
const ts = Date.now();
const created = { roles: [], users: [] };

const lineWith = (text, ...parts) => text.split("\n").find((l) => parts.every((p) => l.includes(p))) || null;

/** The stand-in CATALOGUE_EXTRACT: the golden record of each block, read from THAT block's text. */
const extractModel = (goldenOf) => async (args) => {
  const payload = JSON.parse(args.contents[1].slice(args.contents[1].indexOf("\n") + 1));
  return {
    products: payload.blocks.map(({ blockId, text }) => {
      const g = goldenOf.get(blockId);
      if (!g) return { blockId, isProduct: false };
      const vq = (v) => (v ? { value: v, quote: v } : null);
      return {
        blockId,
        isProduct: true,
        name: { value: g.name, quote: g.name },
        productCode: g.productCode ? { value: g.productCode, quote: lineWith(text, g.productCode) } : null,
        physicalForm: vq(g.physicalForm),
        packaging: vq(g.packaging),
        withdrawalPeriod: vq(g.withdrawalPeriod),
        storage: vq(g.storage),
        // the amount as printed in THIS block (an edited copy prints another one)
        activeIngredients: g.activeIngredients.map((i) => {
          const line = lineWith(text, i.name) || "";
          // the golden amount when the block prints it; else the amount printed after the name (the edited line)
          const after = line.slice(line.indexOf(i.name) + i.name.length).match(/\d[\d.,]*\s+\S+/)?.[0];
          const amountRaw = line.includes(i.amountRaw) || !after ? i.amountRaw : after;
          return { name: i.name, amountRaw, quote: lineWith(text, i.name, amountRaw.split(" ")[0]) || `${i.name} ${amountRaw}` };
        }),
      };
    }),
    catalogue: null,
  };
};
/** The stand-in CATALOGUE_INFER, worded differently on every run. */
const inferModel = (wording) => async (args) => {
  const payload = JSON.parse(args.contents[1].slice(args.contents[1].indexOf("\n") + 1));
  return { products: payload.products.map((p) => ({ blockId: p.blockId, estimates: p.missing.includes("appearance") ? [{ field: "appearance", value: wording, basis: "Oral solutions of this kind are clear liquids." }] : [] })) };
};

async function uploadAndExtract({ catalogueId = null, buffer, label, wording }) {
  const fd = form(catalogueId ? { label, extract: "false" } : { companyId: co.id, manufacturer: "Agrikima Sdn. Bhd.", label, extract: "false" }, { buffer, name: `${label}.pdf`, type: "application/pdf" });
  const r = await api("POST", catalogueId ? `/catalogues/${catalogueId}/versions` : "/catalogues", asAdmin, fd);
  await pollTask(r.data.data.jobId, asAdmin);
  const versionId = r.data.data.versionId;
  const blocks = await prisma.catalogueBlock.findMany({ where: { versionId, kind: "product" }, orderBy: { seq: "asc" } });
  const goldenOf = new Map(blocks.map((b, i) => [b.id, GOLDEN.products[i]]));
  await runExtractJob(versionId, undefined, { generate: extractModel(goldenOf), inferGenerate: inferModel(wording) });
  const idOf = (name) => blocks[GOLDEN.products.findIndex((p) => p.name === name)].id;
  return { versionId, catalogueId: r.data.data.catalogueId, idOf };
}

/** The catalogue with ONE composition line edited in the PDF itself: Agri-CalD3's Phosphoric Acid 30,000 → 50,000 mg. */
async function editedCopy() {
  const doc = await PDFDocument.load(pdf);
  const page = doc.getPages()[7];
  const raw = page.node.Contents();
  const text = Buffer.from(decodePDFRawStream(raw).decode()).toString("latin1");
  const from = "[(Phosphoric A)25 (cid  )-2946.1 (30)20 (,)20 (000 mg)]TJ";
  if (text.split(from).length !== 2) throw new Error("the composition line to edit is not unique on page 8");
  const stream = doc.context.flateStream(Buffer.from(text.replace(from, from.replace("(30)", "(50)")), "latin1"));
  page.node.set(PDFName.of("Contents"), doc.context.register(stream));
  return Buffer.from(await doc.save());
}

async function login(url, username, password) {
  const res = await fetch(`${BASE_URL}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  const body = await res.json();
  if (!body?.data?.token) throw new Error(`login ${url} → ${res.status}`);
  return body.data.token;
}
const bearer = (token) => ({ Authorization: `Bearer ${token}`, "x-force-auth": "true" });
const denied = (r) => r.status === 403 && /permission/i.test(r.data?.message || "");

try {
  // a product typed in before any catalogue existed (§15.8: linked retroactively through the diff)
  const legacy = await prisma.product.create({ data: { companyId: co.id, name: "Kima Immune (old entry)", productCode: "AKS08", storage: "Store below 30°C." } });

  console.log("\n📗 v1 — first upload");
  const v1 = await uploadAndExtract({ buffer: pdf, label: "2022", wording: "Clear liquid" });
  let r = await api("PUT", `/catalogue-versions/${v1.versionId}/number-convention`, asAdmin, { dotGroup3: "thousands" });
  r = await api("GET", `/catalogue-versions/${v1.versionId}/diff`, asCompany(co.id));
  let d = r.data?.data;
  const kima = d?.items.find((i) => i.blockId === v1.idOf("Kima-Immune"));
  assert("diff v1: the legacy product matched by its code; the other 28 blocks are new", r.status === 200 && kima?.kind === "changed" && kima.product.id === legacy.id && kima.matchedBy === "code" && d.summary.new === 28, d?.summary);
  const ch = (item, f) => item.changes.find((c) => c.field === f);
  assert("its typed values are conflicts (entered before the catalogue): storage, name", ch(kima, "storage")?.conflict && ch(kima, "storage").old === "Store below 30°C." && ch(kima, "name")?.conflict && /before this catalogue/.test(ch(kima, "storage").reason));
  assert("an empty field is a plain fill with the block's quote (packaging)", ch(kima, "packaging") && !ch(kima, "packaging").conflict && ch(kima, "packaging").quote && ch(kima, "activeIngredients") && !ch(kima, "activeIngredients").conflict);
  assert("the same code → unchanged, not a change", kima.unchanged.includes("productCode"));
  r = await api("POST", `/catalogue-blocks/${v1.idOf("Kima-Immune")}/accept`, asAdmin);
  assert("accept on it → 409 EXISTING_PRODUCT (existing products change only through the diff)", r.status === 409 && r.data.code === "EXISTING_PRODUCT");
  r = await api("POST", `/catalogue-blocks/${v1.idOf("Agri-CalD3")}/apply-diff`, asAdmin);
  assert("apply-diff on a new block → 409 NO_EXISTING_PRODUCT", r.status === 409 && r.data.code === "NO_EXISTING_PRODUCT");
  r = await api("POST", `/catalogue-blocks/${v1.idOf("Kima-Immune")}/apply-diff`, asAdmin, { fields: ["registrationNumber"] });
  assert("a field that is not a change → 400 NOT_A_CHANGE", r.status === 400 && r.data.code === "NOT_A_CHANGE");
  r = await api("POST", `/catalogue-blocks/${v1.idOf("Kima-Immune")}/apply-diff`, asAdmin);
  let lp = await prisma.product.findUnique({ where: { id: legacy.id } });
  assert("apply per product: the fills applied, the conflicts kept", r.status === 200 && r.data.data.applied.includes("packaging") && r.data.data.keptConflicts.includes("storage") && lp.storage === "Store below 30°C." && lp.name === "Kima Immune (old entry)" && lp.packaging, r.data);
  assert("linked retroactively: catalogueRef → this version's block; fills tier C with quotes; kept values declined (remembered)", lp.catalogueRef.blockId === v1.idOf("Kima-Immune") && lp.fieldProvenance.packaging.tier === "C" && lp.fieldProvenance.packaging.quote && lp.fieldProvenance.storage.declined?.catalogueId === v1.catalogueId && lp.fieldProvenance.storage.tier === "manual");

  r = await api("POST", `/catalogue-versions/${v1.versionId}/accept-unflagged`, asAdmin);
  for (const n of ["Agrizec", "AD3E-CK", "AD3E-PLUS", "BETAINE 50%"]) await api("POST", `/catalogue-blocks/${v1.idOf(n)}/accept`, asAdmin);
  const ad3e = await prisma.product.findMany({ where: { companyId: co.id, productCode: "AKS13" } });
  assert("AD3E-CK and AD3E-PLUS (both AKS13) → two products: a duplicated code never matches", ad3e.length === 2 && new Set(ad3e.map((p) => p.name)).size === 2, ad3e.map((p) => p.name));
  const pending1 = await prisma.catalogueBlock.findMany({ where: { versionId: v1.versionId, kind: "product", status: "pending" } });
  assert("v1: every block decided → applied", pending1.length === 0 && (await prisma.catalogueVersion.findUnique({ where: { id: v1.versionId } })).status === "applied", pending1.map((b) => [b.extracted?.record?.name, b.extracted?.flags]));
  const productsAfterV1 = await prisma.product.count({ where: { companyId: co.id } });

  console.log("\n📘 v2 — the same file again");
  const v2 = await uploadAndExtract({ catalogueId: v1.catalogueId, buffer: pdf, label: "2022 again", wording: "A clear liquid solution" });
  const v2row = await prisma.catalogueVersion.findUnique({ where: { id: v2.versionId } });
  assert("the number convention is inherited from v1 (confirmed once per catalogue)", v2row.numberConvention?.dotGroup3 === "thousands" && v2row.numberConvention.inheritedFromVersionId === v1.versionId);
  const ambiguous = await prisma.catalogueBlock.count({ where: { versionId: v2.versionId, extracted: { path: ["flags"], array_contains: [{ code: "ambiguous_number" }] } } });
  assert("…so nothing is flagged ambiguous again", ambiguous === 0, ambiguous);
  r = await api("GET", `/catalogue-versions/${v2.versionId}/diff`, asAdmin);
  d = r.data.data;
  assert("same file → 0 changed fields, 0 new, 0 removed, 0 ambiguous, 29 unchanged", d.summary.changedFields === 0 && d.summary.new === 0 && d.summary.removed === 0 && d.summary.ambiguous === 0 && d.summary.unchanged === 29, { summary: d.summary, changed: d.items.filter((i) => i.changes?.length).map((i) => [i.name, i.changes.map((c) => c.field)]) });
  assert("the kept value is listed as declined, not as a change", d.items.find((i) => i.blockId === v2.idOf("Kima-Immune")).declined.includes("storage"));
  r = await api("POST", `/catalogue-versions/${v2.versionId}/apply-diff`, asAdmin);
  assert("bulk apply → links the unflagged blocks, 0 fields written; AD3E pair (flagged) waits", r.status === 200 && r.data.data.changedFields === 0 && r.data.data.applied === 27 && r.data.data.skipped.flagged === 2, r.data.data);
  for (const n of ["AD3E-CK", "AD3E-PLUS"]) {
    r = await api("POST", `/catalogue-blocks/${v2.idOf(n)}/apply-diff`, asAdmin);
    assert(`${n}: applied per product to its own product`, r.status === 200 && r.data.data.product.name === n, r.data);
  }
  const calc = await prisma.product.findFirst({ where: { companyId: co.id, productCode: "AKS01" } });
  assert("no product created or removed; catalogueRef and tier-C provenance now cite v2", (await prisma.product.count({ where: { companyId: co.id } })) === productsAfterV1 && calc.catalogueRef.catalogueVersionId === v2.versionId && calc.fieldProvenance.activeIngredients.catalogueVersionId === v2.versionId);
  assert("the estimate kept its v1 wording (an estimate never replaces a value)", calc.appearance === "Clear liquid" && calc.fieldProvenance.appearance.estimated);
  assert("v2 applied", (await prisma.catalogueVersion.findUnique({ where: { id: v2.versionId } })).status === "applied");

  console.log("\n📙 v3 — one composition line edited in the PDF");
  const v3 = await uploadAndExtract({ catalogueId: v1.catalogueId, buffer: await editedCopy(), label: "2023", wording: "Clear" });
  const edited = await prisma.catalogueBlock.findUnique({ where: { id: v3.idOf("Agri-CalD3") } });
  assert("the edited copy reads 50,000 mg in the block's own text", /Phosphoric Acid\s+50,000 mg/.test(edited.text) && edited.extracted.record.activeIngredients.some((i) => i.amountRaw === "50,000 mg"));
  // a product missing from the new edition: its block is gone
  await prisma.catalogueBlock.delete({ where: { id: v3.idOf("DL-METHIONINE") } });
  r = await api("GET", `/catalogue-versions/${v3.versionId}/diff`, asAdmin);
  d = r.data.data;
  const changedItems = d.items.filter((i) => i.kind === "changed");
  assert("exactly 1 changed field: Agri-CalD3 activeIngredients", d.summary.changedFields === 1 && changedItems.length === 1 && changedItems[0].name === "Agri-CalD3" && changedItems[0].changes[0].field === "activeIngredients" && !changedItems[0].changes[0].conflict, { summary: d.summary, changed: changedItems.map((i) => [i.name, i.changes.map((c) => c.field)]) });
  const c1 = changedItems[0].changes[0];
  assert("old → new side by side, with the new quote from the block", c1.old.some((i) => i.amountRaw === "30,000 mg") && c1.new.some((i) => i.amountRaw === "50,000 mg") && c1.page === edited.page, c1);
  const dl = await prisma.product.findFirst({ where: { companyId: co.id, name: "DL-METHIONINE" } });
  assert("DL-METHIONINE is listed as removed — and still exists", d.removed.length === 1 && d.removed[0].productId === dl.id && !!(await prisma.product.findUnique({ where: { id: dl.id } })));

  // a person edits Toxinil's storage after the import → a conflict in v3
  const tox = await prisma.product.findFirst({ where: { companyId: co.id, name: "Toxinil" } });
  r = await api("PATCH", `/products/${tox.id}`, asAdmin, { storage: "Keep in the warehouse, shelf B." });
  r = await api("GET", `/catalogue-versions/${v3.versionId}/diff`, asAdmin);
  d = r.data.data;
  const toxItem = d.items.find((i) => i.blockId === v3.idOf("Toxinil"));
  assert("a field edited by hand after the import → conflict (old = the person's value)", ch(toxItem, "storage")?.conflict && ch(toxItem, "storage").old === "Keep in the warehouse, shelf B." && /edited by a person/.test(ch(toxItem, "storage").reason));

  console.log("\n✋ Tenancy and permissions");
  assert("another company: diff 404", (await api("GET", `/catalogue-versions/${v3.versionId}/diff`, asCompany(other.id))).status === 404);
  const foreign = await prisma.product.create({ data: { companyId: other.id, name: "Agri-CalD3", productCode: "AKS01" } });
  r = await api("POST", `/catalogue-blocks/${v3.idOf("Agri-CalD3")}/apply-diff`, asAdmin, { productId: foreign.id });
  assert("productId of another company → 404, nothing written", r.status === 404 && (await prisma.product.findUnique({ where: { id: foreign.id } })).activeIngredients === null);
  const password = `Pw-${ts}-x`;
  const hash = await bcrypt.hash(password, 10);
  await prisma.company.update({ where: { id: co.id }, data: { password: hash } });
  const companyToken = await login("/companies/login", co.username, password);
  const readProducts = await prisma.permission.findUnique({ where: { slug: "read_products" } });
  const role = await prisma.role.create({ data: { name: `a6d_reader_${ts}`, permissions: { create: [{ permissionId: readProducts.id }] } } });
  created.roles.push(role.id);
  const u = await prisma.user.create({ data: { name: `a6d_reader_${ts}`, username: `a6d_reader_${ts}`, email: `a6d_reader_${ts}@example.invalid`, password: hash, roleId: role.id } });
  created.users.push(u.id);
  const reader = await login("/auth/login", u.username, password);
  for (const [label, token] of [["company token", companyToken], ["system user without manage_catalogues", reader]]) {
    const a = await api("POST", `/catalogue-blocks/${v3.idOf("Agri-CalD3")}/apply-diff`, bearer(token));
    const b = await api("POST", `/catalogue-versions/${v3.versionId}/apply-diff`, bearer(token));
    assert(`${label}: apply per block / per version refused (403)`, denied(a) && denied(b), [a.status, b.status]);
  }
  assert("company token: reads its diff (200)", (await api("GET", `/catalogue-versions/${v3.versionId}/diff`, bearer(companyToken))).status === 200);

  console.log("\n✅ Approve v3");
  r = await api("POST", `/catalogue-versions/${v3.versionId}/apply-diff`, asAdmin);
  const calc3 = await prisma.product.findUnique({ where: { id: calc.id } });
  const pa = calc3.activeIngredients.find((i) => i.name === "Phosphoric Acid");
  assert("bulk: the one change applied (50,000 mg, amount 50000, raw kept); Toxinil (conflict) waits", r.data.data.changedFields === 1 && pa.amountRaw === "50,000 mg" && pa.amount === 50000 && r.data.data.skipped.conflicts === 1, r.data.data);
  assert("its provenance: tier C, v3's block, the value it replaced", calc3.fieldProvenance.activeIngredients.tier === "C" && calc3.fieldProvenance.activeIngredients.blockId === edited.id && calc3.fieldProvenance.activeIngredients.replacedValue.some((i) => i.amountRaw === "30,000 mg"));
  r = await api("POST", `/catalogue-blocks/${v3.idOf("Toxinil")}/apply-diff`, asAdmin, { fields: ["storage"] });
  const tox3 = await prisma.product.findUnique({ where: { id: tox.id } });
  assert("per field: the admin names the conflict → the catalogue value replaces the typed one (tier C again)", r.status === 200 && tox3.storage !== "Keep in the warehouse, shelf B." && tox3.fieldProvenance.storage.tier === "C" && tox3.fieldProvenance.storage.replacedValue === "Keep in the warehouse, shelf B.");
  r = await api("POST", `/catalogue-blocks/${v3.idOf("Toxinil")}/apply-diff`, asAdmin);
  assert("a decided block can't be applied twice (409)", r.status === 409 && r.data.code === "BLOCK_DECIDED");
  assert("DL-METHIONINE still exists after everything was approved", !!(await prisma.product.findUnique({ where: { id: dl.id } })));
} catch (e) {
  assert(`suite crashed: ${e.message}`, false, e.stack);
}

await finish(counts, async () => {
  await cleanupCompany(co.id);
  await cleanupCompany(other.id);
  if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.rolePermission.deleteMany({ where: { roleId: { in: created.roles } } });
  await prisma.role.deleteMany({ where: { id: { in: created.roles } } });
});
