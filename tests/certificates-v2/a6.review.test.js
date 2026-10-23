// Certificate AI layers — Phase A6.4 (plan.md §15.3 steps 6–7; owner rules): the
// admin's review of an extracted catalogue, on the Agrikima sample with stand-in
// models (npm test never calls a paid API).
// Proven: the review lists every block with a highlight box per quoted field (on
// the printed line of that quote); bulk accept takes only unflagged blocks with no
// existing product; accepting CREATES a product with catalogueRef and per-field
// provenance (tier C with the block's quote, tier I estimates apart, typed values
// "manual"); amountRaw kept; specifications only from tables; no category created
// (an existing one is used only by exact name, or the admin's pick); an existing
// product is never touched (→ the §15.4 diff); an ambiguous number blocks the
// accept until the convention is confirmed; a double accept makes one product;
// estimates stay masked for certificates; a person's later edit turns a field
// "manual"; merge/split + extracting only those blocks; tenancy and permissions.
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { api, asAdmin, asCompany, makeAssert, finish, createCompany, cleanupCompany, form, pollTask, prisma, BASE_URL } from "./helpers.js";
import { runExtractJob } from "../../src/services/catalogues/extraction/extractionService.js";
import { maskEstimates } from "../../src/services/catalogues/fieldProvenance.js";

const { assert, counts } = makeAssert();
const pdf = fs.readFileSync(path.join(process.cwd(), "fixtures", "catalogues", "Agrikima_Catalogue_2022-new_-_feed.pdf"));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures", "catalogues", "agrikima.golden.json"), "utf8"));
const co = await createCompany("a6r");
const other = await createCompany("a6r2");
const manualCo = await createCompany("a6r3"); // P8 block: a company with no products yet, so its Toxinil is new
const ts = Date.now();
const created = { categories: [], roles: [], users: [] };

const lineWith = (text, ...parts) => text.split("\n").find((l) => parts.every((p) => l.includes(p))) || null;
const LIQUID = `A6R Liquid Oral Solution ${ts}`; // created below → proposals with this name match it

/** The stand-in CATALOGUE_EXTRACT: the golden record of each block, quoted from that block. */
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
        categoryProposal: /Liquid Oral Solution/.test(text) ? LIQUID : /Soluble Powder/.test(text) ? `A6R Never Created ${ts}` : null,
        activeIngredients: g.activeIngredients.map((i) => ({ name: i.name, amountRaw: i.amountRaw, quote: lineWith(text, i.name, i.amountRaw.split(" ")[0]) || `${i.name} ${i.amountRaw}` })),
      };
    }),
    catalogue: null,
  };
};
/** The stand-in CATALOGUE_INFER: appearance for all, a withdrawal estimate for IMMUSOL only. */
const inferModel = async (args) => {
  const payload = JSON.parse(args.contents[1].slice(args.contents[1].indexOf("\n") + 1));
  return {
    products: payload.products.map((p) => ({
      blockId: p.blockId,
      estimates: [
        ...(p.missing.includes("appearance") ? [{ field: "appearance", value: "Clear liquid", basis: "Oral solutions of this kind are clear liquids." }] : []),
        ...(p.name === "IMMUSOL" && p.missing.includes("withdrawalPeriod") ? [{ field: "withdrawalPeriod", value: "0 days", basis: "Feed additives of this class carry no withdrawal period." }] : []),
      ],
    })),
  };
};

// real tokens, no bypass header — restrictToPermission runs as in production
async function login(url, username, password) {
  const res = await fetch(`${BASE_URL}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  const body = await res.json();
  if (!body?.data?.token) throw new Error(`login ${url} → ${res.status}`);
  return body.data.token;
}
const bearer = (token) => ({ Authorization: `Bearer ${token}`, "x-force-auth": "true" });
const denied = (r) => r.status === 403 && /permission/i.test(r.data?.message || "");

try {
  const categoriesBefore = await prisma.category.count();
  const liquid = await prisma.category.create({ data: { name: LIQUID } });
  created.categories.push(liquid.id);
  const picked = await prisma.category.create({ data: { name: `A6R Picked ${ts}` } });
  created.categories.push(picked.id);

  let r = await api("POST", "/catalogues", asAdmin, form({ companyId: co.id, manufacturer: "Agrikima Sdn. Bhd.", extract: "false" }, { buffer: pdf, name: "agrikima.pdf", type: "application/pdf" }));
  await pollTask(r.data.data.jobId, asAdmin);
  const versionId = r.data.data.versionId;
  const blocks = await prisma.catalogueBlock.findMany({ where: { versionId, kind: "product" }, orderBy: { seq: "asc" } });
  const goldenOf = new Map(blocks.map((b, i) => [b.id, GOLDEN.products[i]]));
  const idOf = (name) => blocks[GOLDEN.products.findIndex((p) => p.name === name)].id;
  await runExtractJob(versionId, undefined, { generate: extractModel(goldenOf), inferGenerate: inferModel });

  // an existing product of this company with one printed code → never applied from the review
  const existing = await prisma.product.create({ data: { companyId: co.id, name: "Kima Immune (old entry)", productCode: "AKS08", storage: "old text" } });

  console.log("\n🔎 The review");
  r = await api("GET", `/catalogue-versions/${versionId}/review`, asCompany(co.id));
  const rv = r.data?.data;
  assert("GET review → 200, every block listed (29 products + context)", r.status === 200 && rv.counts.products === 29 && rv.blocks.length === (await prisma.catalogueBlock.count({ where: { versionId } })), rv?.counts);
  const B = (id) => rv.blocks.find((b) => b.id === id);
  assert("the existing product's block shows the match (by code) and is not bulk-acceptable", B(idOf("Kima-Immune")).match?.productId === existing.id && B(idOf("Kima-Immune")).match.by === "code" && !B(idOf("Kima-Immune")).bulkAcceptable);
  assert("flagged blocks are not bulk-acceptable: Agrizec (ambiguous 200.000), AD3E-CK / AD3E-PLUS (AKS13), IMMUSOL (estimated withdrawal)", ["Agrizec", "AD3E-CK", "AD3E-PLUS", "IMMUSOL"].every((n) => B(idOf(n)).extracted.flags.length && !B(idOf(n)).bulkAcceptable), ["Agrizec", "AD3E-CK", "AD3E-PLUS", "IMMUSOL"].map((n) => B(idOf(n)).extracted.flags.map((f) => f.code)));
  assert("counts add up: unflagged + flagged + existing = products", rv.counts.unflagged + rv.counts.flagged + (rv.counts.existing - rv.blocks.filter((b) => b.match && b.extracted?.flags?.length).length) === 29, rv.counts);

  // highlight boxes: each sits on a line holding the quoted text, inside the block
  let boxes = 0;
  const off = [];
  for (const b of rv.blocks.filter((x) => x.kind === "product")) {
    const raw = blocks.find((x) => x.id === b.id) || (await prisma.catalogueBlock.findUnique({ where: { id: b.id } }));
    for (const [field, list] of Object.entries(b.highlights)) {
      for (const h of list) {
        boxes++;
        const line = raw.lines.find((l) => l.y === h.y && h.x >= l.x - 0.1 && h.x + h.w <= l.x + l.w + 0.2);
        const bb = raw.bbox;
        if (!line || h.y < bb.y - 0.5 || h.y + h.h > bb.y + bb.h + 0.5) off.push([b.title, field, h]);
      }
    }
  }
  assert(`every highlight box (${boxes}) lies on one of its block's printed lines, inside the block`, boxes > 200 && off.length === 0, off.slice(0, 3));
  const ag = B(idOf("Agri-CalD3"));
  const q = ag.extracted.quotes.productCode;
  const codeLine = blocks.find((x) => x.id === ag.id).lines.find((l) => q.start >= l.o && q.end <= l.o + l.t.length);
  assert("the productCode box is on the line printing AKS01, and no wider than that line", ag.highlights.productCode.length === 1 && ag.highlights.productCode[0].y === codeLine.y && ag.highlights.productCode[0].w <= codeLine.w && codeLine.t.includes("AKS01"));
  assert("ingredient rows: one box per quoted row", B(idOf("Aminovital")).highlights.activeIngredients.length >= B(idOf("Aminovital")).extracted.record.activeIngredients.length);
  assert("categories: the exact-name existing one preselected, an unknown proposal → none", rv.blocks.some((b) => b.categoryId === liquid.id) && rv.blocks.filter((b) => b.extracted?.category?.proposal?.startsWith("A6R Never")).every((b) => b.categoryId === null));

  console.log("\n✋ Permissions and tenancy");
  r = await api("GET", `/catalogue-versions/${versionId}/review`, asCompany(other.id));
  assert("another company: review 404", r.status === 404);
  r = await api("POST", `/catalogue-blocks/${idOf("Agri-CalD3")}/accept`, asCompany(other.id));
  assert("another company: accept 404 (or 403) — nothing created", [403, 404].includes(r.status) && !(await prisma.product.count({ where: { companyId: other.id } })));
  const password = `Pw-${ts}-x`;
  const hash = await bcrypt.hash(password, 10);
  await prisma.company.update({ where: { id: co.id }, data: { password: hash } });
  const companyToken = await login("/companies/login", co.username, password);
  const readProducts = await prisma.permission.findUnique({ where: { slug: "read_products" } });
  const role = await prisma.role.create({ data: { name: `a6r_reader_${ts}`, permissions: { create: [{ permissionId: readProducts.id }] } } });
  created.roles.push(role.id);
  const u = await prisma.user.create({ data: { name: `a6r_reader_${ts}`, username: `a6r_reader_${ts}`, email: `a6r_reader_${ts}@example.invalid`, password: hash, roleId: role.id } });
  created.users.push(u.id);
  const reader = await login("/auth/login", u.username, password);
  for (const [label, token] of [["company token", companyToken], ["system user without manage_catalogues", reader]]) {
    const call = async (method, url, body) => api(method, url, bearer(token), body);
    const all = [
      await call("POST", `/catalogue-blocks/${idOf("Agri-CalD3")}/accept`),
      await call("POST", `/catalogue-blocks/${idOf("Agri-CalD3")}/reject`),
      await call("PATCH", `/catalogue-blocks/${idOf("Agri-CalD3")}`, { values: { appearance: "x" } }),
      await call("POST", `/catalogue-versions/${versionId}/accept-unflagged`),
      await call("POST", `/catalogue-blocks/${idOf("Agri-CalD3")}/split`, { atLine: 2 }),
    ];
    assert(`${label}: accept / reject / edit / bulk / split refused (403)`, all.every(denied), all.map((x) => x.status));
  }
  r = await api("GET", `/catalogue-versions/${versionId}/review`, bearer(companyToken));
  assert("company token: reads its own review (200)", r.status === 200);

  console.log("\n✏️ Edits before accepting");
  r = await api("PATCH", `/catalogue-blocks/${idOf("Agri-CalD3")}`, asAdmin, { values: { activeIngredients: "x" } });
  assert("amounts can't be typed (400 NOT_EDITABLE)", r.status === 400 && r.data.code === "NOT_EDITABLE");
  r = await api("PATCH", `/catalogue-blocks/${idOf("Agri-CalD3")}`, asAdmin, { categoryId: "00000000-0000-4000-8000-0000000000c1" });
  assert("an unknown category → 404", r.status === 404);
  r = await api("PATCH", `/catalogue-blocks/${idOf("Agri-CalD3")}`, asAdmin, { values: { indications: "Typed by the admin." }, categoryId: picked.id });
  assert("typed value + picked category stored on the block (200)", r.status === 200 && r.data.data.extracted.manual.indications.value === "Typed by the admin." && r.data.data.extracted.category.chosenCategoryId === picked.id);

  console.log("\n✅ Accept one");
  r = await api("POST", `/catalogue-blocks/${idOf("Agri-CalD3")}/accept`, asAdmin);
  const p1 = r.data?.data?.product;
  const blk = await prisma.catalogueBlock.findUnique({ where: { id: idOf("Agri-CalD3") } });
  assert("accept → 201, a product created for this company, block applied + linked", r.status === 201 && p1.companyId === co.id && blk.status === "applied" && blk.productId === p1.id, r.data);
  assert("catalogueRef = { catalogue, version, block, page }", p1.catalogueRef.catalogueVersionId === versionId && p1.catalogueRef.blockId === blk.id && p1.catalogueRef.page === blk.page && p1.catalogueRef.catalogueId);
  const fp = p1.fieldProvenance;
  assert("productCode / storage: tier C with the block's quote (found in that block's text)", fp.productCode.tier === "C" && blk.text.includes(fp.productCode.quote) && fp.storage?.tier === "C" && blk.text.includes(fp.storage.quote), fp);
  assert("appearance: tier I estimate apart (estimated, basis, modelId, promptHash)", fp.appearance.tier === "I" && fp.appearance.estimated === true && fp.appearance.basis && fp.appearance.modelId && fp.appearance.promptHash && p1.appearance === "Clear liquid");
  assert("indications: the admin's typed value, tier manual", p1.indications === "Typed by the admin." && fp.indications.tier === "manual");
  assert("the admin's category, not the proposal; brand from the catalogue (none here)", p1.categoryId === picked.id);
  const g = GOLDEN.products.find((x) => x.name === "Agri-CalD3");
  assert("activeIngredients: amountRaw kept for every printed amount, concentration = the printed text", p1.activeIngredients.length === g.activeIngredients.length && g.activeIngredients.every((i) => p1.activeIngredients.some((x) => x.name === i.name && x.amountRaw === i.amountRaw && x.concentration === i.amountRaw)));
  assert("no composition in specifications (no SPECIFICATIONS table on this page)", !p1.specifications);
  r = await api("POST", `/catalogue-blocks/${idOf("Agri-CalD3")}/accept`, asAdmin);
  assert("a second accept → 409 BLOCK_DECIDED", r.status === 409 && r.data.code === "BLOCK_DECIDED");
  r = await api("PATCH", `/catalogue-blocks/${idOf("Agri-CalD3")}`, asAdmin, { values: { appearance: "x" } });
  assert("editing a decided block → 409", r.status === 409);

  console.log("\n🚫 Existing products and blocking flags");
  r = await api("POST", `/catalogue-blocks/${idOf("Kima-Immune")}/accept`, asAdmin);
  const ex2 = await prisma.product.findUnique({ where: { id: existing.id } });
  assert("a block matching an existing product → 409 EXISTING_PRODUCT, the product untouched", r.status === 409 && r.data.code === "EXISTING_PRODUCT" && ex2.storage === "old text" && ex2.name === "Kima Immune (old entry)" && !ex2.catalogueRef);
  r = await api("POST", `/catalogue-blocks/${idOf("Agrizec")}/accept`, asAdmin);
  assert("Agrizec (200.000 ambiguous) → 409 CONFIRM_NUMBER_CONVENTION", r.status === 409 && r.data.code === "CONFIRM_NUMBER_CONVENTION");

  console.log("\n📦 Bulk accept");
  const catsMid = await prisma.category.count();
  r = await api("POST", `/catalogue-versions/${versionId}/accept-unflagged`, asAdmin);
  const bulk = r.data?.data;
  const unflaggedLeft = rv.counts.unflagged - 1; // Agri-CalD3 was accepted alone
  assert(`bulk → only the unflagged, unmatched blocks (${unflaggedLeft}) became products`, r.status === 200 && bulk.created === unflaggedLeft && bulk.skipped.flagged >= 4 && bulk.skipped.existing >= 1, bulk);
  const bulkProducts = await prisma.product.findMany({ where: { id: { in: bulk.products.map((x) => x.productId) } } });
  assert("each bulk product has catalogueRef and tier-C provenance for its code (if printed)", bulkProducts.every((p) => p.catalogueRef?.blockId && (!p.productCode || p.fieldProvenance.productCode?.tier === "C")));
  assert("no category created by the review (only the two this test made)", (await prisma.category.count()) === catsMid && catsMid === categoriesBefore + 2);
  assert("a proposal matching an existing category by exact name → that category; an unknown one → none", bulkProducts.some((p) => p.categoryId === liquid.id) && bulkProducts.every((p) => [null, liquid.id].includes(p.categoryId)));
  const betaine = bulkProducts.find((p) => p.name === "BETAINE 50%");
  assert("Betaine's specifications from its SPECIFICATIONS table (Assay ≥ 50), quoted", betaine?.specifications?.values && Object.values(betaine.specifications.values).some((v) => /50/.test(v)) && betaine.fieldProvenance.specifications.tier === "C", betaine?.specifications);
  assert("flagged ones still pending: Agrizec, AD3E-CK, AD3E-PLUS, IMMUSOL, Kima-Immune", (await prisma.catalogueBlock.findMany({ where: { id: { in: ["Agrizec", "AD3E-CK", "AD3E-PLUS", "IMMUSOL", "Kima-Immune"].map(idOf) } } })).every((b) => b.status === "pending"));
  r = await api("POST", `/catalogue-versions/${versionId}/accept-unflagged`, asAdmin);
  assert("bulk again → nothing new", r.data.data.created === 0);

  console.log("\n🔢 Convention, then the flagged ones");
  r = await api("PUT", `/catalogue-versions/${versionId}/number-convention`, asAdmin, { dotGroup3: "thousands" });
  r = await api("POST", `/catalogue-blocks/${idOf("Agrizec")}/accept`, asAdmin);
  const agz = r.data?.data?.product;
  const zinc = agz?.activeIngredients?.find((i) => i.amountRaw === "200.000 mg" || i.amountRaw?.startsWith("200.000"));
  assert("after the convention: Agrizec accepted, 200.000 → 200000 with amountRaw kept", r.status === 201 && zinc && zinc.amount === 200000, agz?.activeIngredients);
  // a double accept of one block: one product
  const [a1, a2] = await Promise.all([api("POST", `/catalogue-blocks/${idOf("AD3E-CK")}/accept`, asAdmin), api("POST", `/catalogue-blocks/${idOf("AD3E-CK")}/accept`, asAdmin)]);
  assert("two accepts at once → exactly one product (the other 409)", [a1.status, a2.status].sort().join() === "201,409" && (await prisma.product.count({ where: { companyId: co.id, name: "AD3E-CK" } })) === 1, [a1.status, a2.status]);
  r = await api("POST", `/catalogue-blocks/${idOf("IMMUSOL")}/accept`, asAdmin);
  const mix = r.data?.data?.product;
  assert("IMMUSOL accepted by a person: the withdrawal estimate kept as tier I estimated", r.status === 201 && mix.withdrawalPeriod === "0 days" && mix.fieldProvenance.withdrawalPeriod.estimated === true);
  const masked = maskEstimates(await prisma.product.findUnique({ where: { id: mix.id } }));
  assert("certificates read it masked (unconfirmed estimate → empty)", masked.withdrawalPeriod === null && masked.appearance === null && masked.name === "IMMUSOL");
  r = await api("POST", `/catalogue-blocks/${idOf("AD3E-PLUS")}/reject`, asAdmin);
  assert("reject → status rejected, no product written", r.status === 200 && (await prisma.catalogueBlock.findUnique({ where: { id: idOf("AD3E-PLUS") } })).status === "rejected" && !(await prisma.product.count({ where: { companyId: co.id, name: "AD3E-PLUS" } })));

  console.log("\n🖊️ A person's later edit on the product");
  r = await api("PATCH", `/products/${mix.id}`, asAdmin, { withdrawalPeriod: "7 days", appearance: "Clear liquid", activeIngredients: mix.activeIngredients });
  const mix2 = await prisma.product.findUnique({ where: { id: mix.id } });
  assert("the edit is accepted with amountRaw / amount on ingredients (and null concentration allowed)", r.status === 200 && mix2.activeIngredients.every((i, k) => i.amountRaw === mix.activeIngredients[k].amountRaw), r.data);
  assert("a changed estimate → tier manual (badge gone, certificates may use it); an unchanged one stays an estimate", mix2.fieldProvenance.withdrawalPeriod.tier === "manual" && mix2.fieldProvenance.withdrawalPeriod.replaced === "I" && mix2.fieldProvenance.appearance.estimated === true && maskEstimates(mix2).withdrawalPeriod === "7 days");
  assert("unchanged catalogue values keep tier C", mix2.fieldProvenance.name?.tier === "C" && mix2.fieldProvenance.activeIngredients?.tier === "C", { fp: mix2.fieldProvenance, before: mix.activeIngredients, after: mix2.activeIngredients });

  console.log("\n✂️ Merge / split, then extract just those blocks");
  const kima = await prisma.catalogueBlock.findUnique({ where: { id: idOf("Kima-Immune") } });
  const otherPage = blocks.find((b) => b.page !== kima.page && b.id !== kima.id);
  r = await api("POST", `/catalogue-versions/${versionId}/merge-blocks`, asAdmin, { blockIds: [kima.id, idOf("Agri-Hepa+")] });
  assert("merging a decided block → 409", r.status === 409, r.data);
  r = await api("POST", `/catalogue-blocks/${idOf("Agri-CalD3")}/split`, asAdmin, { atLine: 2 });
  assert("splitting an applied block → 409", r.status === 409);
  r = await api("POST", `/catalogue-blocks/${kima.id}/split`, asAdmin, { atLine: kima.lines.length });
  assert("split outside the lines → 400 INVALID_SPLIT", r.status === 400 && r.data.code === "INVALID_SPLIT");
  const at = Math.floor(kima.lines.length / 2);
  r = await api("POST", `/catalogue-blocks/${kima.id}/split`, asAdmin, { atLine: at });
  const newId = r.data?.data?.newBlockId;
  const [k1, k2] = await Promise.all([prisma.catalogueBlock.findUnique({ where: { id: kima.id } }), prisma.catalogueBlock.findUnique({ where: { id: newId } })]);
  assert("split → two blocks; the text is the original, cut at the line; offsets restart; extraction cleared", r.status === 200 && `${k1.text}\n${k2.text}` === kima.text && k2.lines[0].o === 0 && k1.lines.length === at && !k1.extracted && !k2.extracted && k2.seq === k1.seq + 1);
  const seqs = (await prisma.catalogueBlock.findMany({ where: { versionId }, orderBy: { seq: "asc" }, select: { seq: true } })).map((b) => b.seq);
  assert("seq stays contiguous", seqs.every((s, i) => s === i));
  r = await api("POST", `/catalogue-versions/${versionId}/merge-blocks`, asAdmin, { blockIds: [kima.id, otherPage.id] });
  assert("merging blocks of different pages → 409 (or decided)", r.status === 409);
  r = await api("POST", `/catalogue-versions/${versionId}/merge-blocks`, asAdmin, { blockIds: [kima.id, newId] });
  const merged = await prisma.catalogueBlock.findUnique({ where: { id: kima.id } });
  assert("merge back → one block, text as printed again, the other row deleted", r.status === 200 && merged.text === kima.text && !(await prisma.catalogueBlock.findUnique({ where: { id: newId } })));
  r = await api("POST", `/catalogue-versions/${versionId}/extract`, asAdmin, { blockIds: [idOf("Agri-CalD3")] });
  assert("extracting a decided block → 409 BLOCKS_IN_USE", r.status === 409 && r.data.code === "BLOCKS_IN_USE");
  const foreign = await prisma.catalogueBlock.findFirst({ where: { companyId: { not: co.id } }, select: { id: true } });
  if (foreign) {
    r = await api("POST", `/catalogue-versions/${versionId}/extract`, asAdmin, { blockIds: [foreign.id] });
    assert("extracting a block of another version → 404", r.status === 404);
  }
  const beforeOthers = new Map((await prisma.catalogueBlock.findMany({ where: { versionId, kind: "product", id: { not: kima.id } } })).map((b) => [b.id, JSON.stringify(b.extracted)]));
  await runExtractJob(versionId, undefined, { generate: extractModel(goldenOf), infer: false, blockIds: [kima.id] });
  const afterAll = await prisma.catalogueBlock.findMany({ where: { versionId, kind: "product" } });
  const reread = afterAll.find((b) => b.id === kima.id);
  assert("only the merged block was read again (record back), every other block's extraction unchanged", reread.extracted?.record?.name === "Kima-Immune" && afterAll.filter((b) => b.id !== kima.id).every((b) => JSON.stringify(b.extracted) === beforeOthers.get(b.id)));
  const v = await prisma.catalogueVersion.findUnique({ where: { id: versionId } });
  assert("the version records the partial run", v.extraction.lastPartial?.blockIds?.[0] === kima.id && v.status === "review");

  console.log("\n🏁 Version applied when nothing is pending");
  for (const b of afterAll.filter((x) => x.status === "pending")) await api("POST", `/catalogue-blocks/${b.id}/reject`, asAdmin);
  const done = await prisma.catalogueVersion.findUnique({ where: { id: versionId } });
  assert("all decided → version applied (appliedAt set)", done.status === "applied" && !!done.appliedAt);

  console.log("\n✍️ P8 — AI unavailable: products entered by hand");
  {
    const up = await api("POST", "/catalogues", asAdmin, form({ companyId: manualCo.id, manufacturer: "Manual entry test", extract: "false" }, { buffer: pdf, name: "m.pdf", type: "application/pdf" }));
    await pollTask(up.data.data.jobId, asAdmin);
    const mv = up.data.data.versionId;
    const mb = (await prisma.catalogueBlock.findMany({ where: { versionId: mv, kind: "product" }, orderBy: { seq: "asc" } }))[GOLDEN.products.findIndex((p) => p.name === "Toxinil")];
    r = await api("POST", `/catalogue-blocks/${mb.id}/accept`, asAdmin);
    assert("a never-extracted block can't be accepted empty (409)", r.status === 409);
    r = await api("PATCH", `/catalogue-blocks/${mb.id}`, asAdmin, { values: { name: "Toxinil", productCode: "AKF029", storage: "Typed from the page." } });
    const mex = r.data?.data?.extracted;
    assert("typing into it starts a manual record: no AI values, flagged manual_entry", r.status === 200 && mex.manualOnly && !Object.keys(mex.record).length && !Object.keys(mex.estimated).length && mex.flags.some((f) => f.code === "manual_entry"), mex);
    r = await api("GET", `/catalogue-versions/${mv}/review`, asAdmin);
    assert("…not bulk-acceptable (a person accepts it alone)", !r.data.data.blocks.find((b) => b.id === mb.id).bulkAcceptable);
    // a later extraction (AI back) keeps what the person typed
    const golden1 = new Map([[mb.id, GOLDEN.products.find((p) => p.name === "Toxinil")]]);
    await runExtractJob(mv, undefined, { generate: extractModel(golden1), infer: false, blockIds: [mb.id] });
    const reEx = (await prisma.catalogueBlock.findUnique({ where: { id: mb.id } })).extracted;
    assert("a later extraction keeps the typed values", reEx.manual?.storage?.value === "Typed from the page." && reEx.record?.name === "Toxinil");
    r = await api("POST", `/catalogue-blocks/${mb.id}/accept`, asAdmin);
    const mp = r.data?.data?.product;
    assert("accept → product from the typed values (tier manual), linked to its page", r.status === 201 && mp.storage === "Typed from the page." && mp.fieldProvenance.storage.tier === "manual" && mp.catalogueRef.blockId === mb.id, r.data);
  }
} catch (e) {
  assert(`suite crashed: ${e.message}`, false, e.stack);
}

await finish(counts, async () => {
  await cleanupCompany(co.id);
  await cleanupCompany(other.id);
  await cleanupCompany(manualCo.id);
  if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  for (const id of created.roles) {
    await prisma.rolePermission.deleteMany({ where: { roleId: id } });
    await prisma.role.delete({ where: { id } });
  }
  if (created.categories.length) await prisma.category.deleteMany({ where: { id: { in: created.categories } } });
});
