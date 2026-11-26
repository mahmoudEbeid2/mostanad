// 26 Nov production test, Phase 3 — Express from files to certificates without dead ends:
//   1 the company question offers "شركة جديدة: <name from the files>" (frontend util)
//   2 every row has its country — whole files too (from the file name / its pages)
//   3 "استخدم الشهادات اللي بعتها كقوالب…" → a card (the model claiming it twice is no dead end)
//   4 products from a COC get their composition, basis, pack and form, with file / page
//   5 a design listing several products → one repeating row; ONE certificate covers them all
//   6 an unclear page's product → one short question with a suggestion, never a silent guess
// The model is a script. Needs `npm run dev:test` (+ pdf2htmlex with ?bg=svg for item 5).
import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, api, asAdmin, createCompany, cleanupCompany } from "./certificates-v2/helpers.js";
import * as assistant from "../src/services/assistant/assistantService.js";
import { runAgent } from "../src/services/assistant/agent/agentLoop.js";
import { storeAttachments } from "../src/services/assistant/attachments.js";
import * as actions from "../src/services/assistant/actions.js";
import { wantsTemplatesFromFiles, codesIn } from "../src/services/assistant/agent/answerGuard.js";
import { resolveDrop } from "../src/services/intake/intakeResolve.js";
import { compositionFrom } from "../src/services/intake/intakeRules.js";
import { fillFromComposition } from "../src/services/intake/intakeExecute.js";
import { runExpress } from "../src/services/intake/expressService.js";
import { createTemplateFromUpload } from "../src/services/certificates/templates/templateService.js";
import { guessCompanyName } from "../../mostanad_front/src/utils/companyGuess.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const admin = { kind: "user", id: "00000000-0000-0000-0000-000000000000", name: "bypass", permissions: null };
const script = (steps) => {
  const seen = [];
  return { seen, generate: async (req) => (seen.push(req), { content: { role: "model", parts: steps[Math.min(seen.length - 1, steps.length - 1)] }, usage: { promptTokenCount: 5, candidatesTokenCount: 1 } }) };
};
const scope = (companies = [], products = []) => ({ companies, brands: [], products, categories: [] });
const item = (id, name, c, extra = {}) => ({ id, name, sha256: id, parentId: null, classification: { productNames: [], companies: [], ...c }, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("1 · the company question");
  const files = ["ADDVET OMAN COA 10-26.pdf", "ADDVET OMAN COC 10-26.pdf", "ADDVET HC OMAN 10-26.pdf", "27 - ADDOXY 200-LA.pdf", "1 SULFAPRIM.pdf"];
  assert("the 5 ADDVET files → «شركة جديدة: ADDVET» (not OMAN, COA, a product)", guessCompanyName(files, "دي شهادات ADDVET وليبلات منتجين") === "ADDVET");
  assert("no shared word → no guess (only «خلّي السيستم يحدد»)", guessCompanyName(["scan 1.pdf", "photo.png"], "خد دول") === null);

  // Phase 7 found it: another company with a brand "ADDVET" captured the drop the person said was a new ADDVET
  const sc = { companies: [{ id: "c-vet", name: "Vetline" }], brands: [{ id: "b-addvet", name: "ADDVET", companyId: "c-vet" }], products: [] };
  const named = [item("x1", "ADDVET OMAN COA.pdf", { docType: "certificate_filled", certCode: "COA", companies: [{ name: "ADDVET" }] })];
  let pr = (await resolveDrop({ items: named, scope: sc })).proposals.get("x1");
  assert("without a choice, a company whose brand is ADDVET is matched (Vetline)", pr.company?.id === "c-vet", pr.company);
  pr = (await resolveDrop({ items: named, scope: sc, newCompanyName: "ADDVET" })).proposals.get("x1");
  assert("«شركة جديدة: ADDVET» chosen → a NEW ADDVET, never Vetline", pr.company?.isNew === true && pr.company.name === "ADDVET" && !pr.company.id, pr.company);

  console.log("\n2 · a country on every row");
  const bundle = item("b1", "ADDVET OMAN COA 10-26.pdf", { docType: "certificate_filled", certCode: "COA", parts: [{ from: 1 }], expanded: null });
  const part = item("b1p1", "ADDVET OMAN COA 10-26.pdf — ADDMECTIN 1%", { docType: "certificate_filled", certCode: "COA", productNames: ["ADDMECTIN 1%"] }, { parentId: "b1", pageFrom: 1 });
  const label = item("l1", "27 - ADDOXY 200-LA.pdf", { docType: "label", productNames: ["ADDOXY 200-LA"] });
  let { proposals } = await resolveDrop({ items: [bundle, part, label], scope: scope() });
  assert("the whole file: OMAN from its name (it showed «—»)", proposals.get("b1")?.country === "OM" && proposals.get("b1").countryFrom === "name", proposals.get("b1"));
  assert("its page: the same country", proposals.get("b1p1")?.country === "OM", proposals.get("b1p1"));
  assert("a label of the drop without one: the drop's country, said so", proposals.get("l1")?.country === "OM" && proposals.get("l1").countryFrom === "drop", proposals.get("l1"));

  console.log("\n6 · an unclear page → one question with a suggestion");
  const coc = item("c", "ADDVET OMAN COC 10-26.pdf", { docType: "certificate_filled", certCode: "COC", parts: [{ from: 1 }, { from: 2 }, { from: 3 }] });
  const coa = item("a", "ADDVET OMAN COA 10-26.pdf", { docType: "certificate_filled", certCode: "COA", parts: [{ from: 1 }, { from: 2 }, { from: 3 }] });
  const pg = (p, n, name, q = null) => item(`${p.id}${n}`, `${p.name} — ${name || `p.${n}`}`, { docType: "certificate_filled", certCode: p.classification.certCode, productNames: name ? [name] : [], question: q }, { parentId: p.id, pageFrom: n });
  const drop = [coc, coa, pg(coc, 1, "ADDMECTIN 1%"), pg(coc, 2, "SULFARIM"), pg(coc, 3, "OLIGOVET"), pg(coa, 1, "ADDMECTIN 1%"), pg(coa, 2, "SULFARIM"), pg(coa, 3, null, "product")];
  ({ proposals } = await resolveDrop({ items: drop, scope: scope() }));
  const p3 = proposals.get("a3");
  assert("COA page 3 prints no product → asked, with «OLIGOVET» suggested from page 3 of the COC", p3?.question === "product" && p3.suggested?.name === "OLIGOVET" && /page 3 of ADDVET OMAN COC/.test(p3.suggested.says) && !p3.products.length, p3);
  assert("…the suggestion is never applied by itself", !p3.products.some((x) => x.name === "OLIGOVET"));
  assert("a sure page gets no question", !proposals.get("a1").question && !proposals.get("a1").suggested);

  console.log("\n4 · composition from the COC");
  const cocPages = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "addvet-coc-pages.json"), "utf8"));
  const c1 = compositionFrom(cocPages[0].text);
  assert("ADDMECTIN 1%: per «Each 1 mL contains», Ivermectin 10 mg, excipients ad 1 mL, pack 100mL, form Liquid", c1.tradeName === "ADDMECTIN 1%" && c1.basis === "Each 1 mL contains" && c1.ingredients[0].name === "Ivermectin" && c1.ingredients[0].amountRaw === "10 mg" && c1.ingredients[1].amountRaw === "ad 1 mL" && c1.packaging === "100mL" && c1.form === "Liquid", c1);
  const c3 = compositionFrom(cocPages[2].text);
  assert("OLIGOVET: 12 ingredients + excipients, «Vitamin A, retinol palmitate» 15,000 IU, B12 60 μg", c3.ingredients.length === 13 && c3.ingredients[0].name === "Vitamin A, retinol palmitate" && c3.ingredients[0].amountRaw === "15,000 IU" && c3.ingredients.find((x) => /B12/.test(x.name))?.amountRaw === "60 μg", c3.ingredients.slice(0, 3));
  const c9 = compositionFrom(cocPages[8].text);
  assert("CURCUMARIN: «Quantity not stated» kept as not stated, never a number", c9.ingredients.length === 2 && c9.ingredients.every((x) => x.amountRaw === "not stated" && x.amount === null), c9.ingredients);
  assert("all 10 pages read (each with ingredients and a pack size)", cocPages.every((p) => compositionFrom(p.text)?.ingredients.length && compositionFrom(p.text)?.packaging));

  const co = await createCompany("p3");
  await assistant.updateSettings("system", { enabled: true, messagesPerUserPerHour: 1000, modelCallsPerDay: 100000 });
  try {
    const product = await prisma.product.create({ data: { companyId: co.id, name: "ADDMECTIN 1%" } });
    const done = await fillFromComposition({ name: "ADDVET OMAN COC 10-26.pdf — ADDMECTIN 1%", pageFrom: 1, classification: { composition: c1 } }, { companyId: co.id, productIds: [product.id] });
    let row = await prisma.product.findUnique({ where: { id: product.id } });
    assert("the product gets its ingredients (with the basis), pack and form", done.filled.includes("activeIngredients") && row.activeIngredients[0].name === "Ivermectin" && row.activeIngredients[0].basis === "Each 1 mL contains" && row.packaging === "100mL" && row.physicalForm === "Liquid", row);
    assert("…each with its file, page and the printed quote", row.fieldProvenance.activeIngredients.file === "ADDVET OMAN COC 10-26.pdf" && row.fieldProvenance.activeIngredients.page === 1 && /Ivermectin 10 mg/.test(row.fieldProvenance.activeIngredients.quote), row.fieldProvenance.activeIngredients);
    await prisma.product.update({ where: { id: product.id }, data: { packaging: "250 mL" } });
    await prisma.product.update({ where: { id: product.id }, data: { activeIngredients: [] } });
    await fillFromComposition({ name: "x.pdf", pageFrom: 1, classification: { composition: c1 } }, { companyId: co.id, productIds: [product.id] });
    row = await prisma.product.findUnique({ where: { id: product.id } });
    assert("a value a person set is never overwritten (pack 250 mL stays); an empty one is filled", row.packaging === "250 mL" && row.activeIngredients.length === 2);

    console.log("\n3 · «استخدم الشهادات اللي بعتها كقوالب…» — never a dead end");
    const msg = "استخدم الشهادات اللي بعتها كقوالب (COA و COC و HC) وطلّع منها شهادات للعشر منتجات";
    assert("the message is recognised; COA, COC, HC read", wantsTemplatesFromFiles(msg) && codesIn(msg).join() === "COA,COC,HC");
    const bypassId = (await api("GET", "/auth/me", asAdmin)).data?.data?.user?.id;
    if (bypassId) admin.id = bypassId;
    const conv = await assistant.createConversation(admin, { companyId: co.id });
    const pdf = async (title) => {
      const d = await PDFDocument.create();
      const f = await d.embedFont(StandardFonts.Helvetica);
      d.addPage([595, 842]).drawText(title, { x: 30, y: 800, size: 10, font: f });
      return Buffer.from(await d.save());
    };
    const atts = await storeAttachments({ conversationId: conv.id, companyId: co.id, actor: admin, files: await Promise.all(["COA", "COC", "HC"].map(async (c) => ({ buffer: await pdf(`ADDVET OMAN ${c}`), originalname: `ADDVET OMAN ${c} 10-26.pdf`, mimetype: "application/pdf" }))) });
    // the drop as production left it: filed, the certificates kept as evidence only, 0 certificates
    const batch = await prisma.intakeBatch.create({ data: { ownerType: "user", ownerId: admin.id, companyId: co.id, conversationId: conv.id, status: "done", mode: "express", executedAt: new Date(), express: { stage: "done", templates: {}, certificates: [], generation: { problemCode: "no_types" } } } });
    for (const [k, a] of atts.entries()) {
      const att = await prisma.assistantAttachment.findUnique({ where: { id: a.id } });
      await prisma.intakeItem.create({ data: { batchId: batch.id, name: a.name, sizeBytes: 1, receivedBytes: 1, fileId: att.fileId, status: "done", companyId: co.id, classification: { docType: "certificate_filled", certCode: ["COA", "COC", "HC"][k], productNames: [] }, result: { plan: { action: "certificate_filled", companyId: co.id, certCode: ["COA", "COC", "HC"][k], productIds: [product.id] } } } });
    }
    const claim = [{ text: "تم تجهيز القوالب من الشهادات اللي بعتها، وهتطلع الشهادات حالًا." }];
    const m = script([claim, claim]);
    const actor = { ...admin };
    const ctx = { actor, scope: { companyId: co.id }, conversationId: conv.id, attachments: [], audit: async () => {}, companyExists: async (id) => !!(await prisma.company.findUnique({ where: { id }, select: { id: true } })), propose: (p) => actions.proposeAction({ conversationId: conv.id, messageId: null, actor, ...p }) };
    const out = await runAgent({ text: msg, ctx, generate: m.generate });
    const guarded = out.toolCalls.find((c) => c.name === "use_files_as_templates");
    const card = await prisma.assistantAction.findFirst({ where: { conversationId: conv.id, tool: "use_files_as_templates" }, orderBy: { createdAt: "desc" } });
    assert("the model claimed it twice without a tool → the guard prepares the card itself", !!guarded && guarded.proposedByGuard && card?.status === "pending", { calls: out.toolCalls, card: card?.status });
    assert("…and says the card is there — not «لم أُجهّز أي عملية»", !/لم أُجهّز/.test(out.text) && /كارت/.test(out.text), out.text);
    const det = Object.fromEntries((card.preview?.details || []).map((d) => [d.label, d.value]));
    assert("the card: each certificate file → its template", /COA template/.test(det["ADDVET OMAN COA 10-26.pdf"]) && /COC template/.test(det["ADDVET OMAN COC 10-26.pdf"]) && /HC template/.test(det["ADDVET OMAN HC 10-26.pdf"]), det);
    const ran = await actions.approveAction(actor, card.id);
    const after = await prisma.certificateTemplate.findMany({ where: { companyId: co.id }, include: { certificateType: { select: { code: true } } } });
    const b2 = await prisma.intakeBatch.findUnique({ where: { id: batch.id } });
    assert("Run → COA, COC and HC templates from those files, and Express runs again", ["done", "running"].includes(ran.status) && ["COA", "COC", "HC"].every((c) => after.some((t) => t.certificateType.code === c)) && b2.express.stage === "templates", { status: ran.status, error: ran.error, codes: after.map((t) => t.certificateType.code) });

    const other = script([[{ text: "تم تحديث كل حاجة." }], [{ text: "تم تحديث كل حاجة." }]]);
    const o2 = await runAgent({ text: "اعمل اللازم", ctx, generate: other.generate });
    const next = o2.blocks.find((b) => b.type === "choices");
    assert("an unclear request after a false claim → buttons of what to ask next, never a bare dead end", next?.items?.length >= 2 && next.items.every((c) => c.say), o2.blocks);

    console.log("\n5 · several products in one table → one certificate for all");
    const fsc = await PDFDocument.create();
    const font = await fsc.embedFont(StandardFonts.Helvetica);
    const page = fsc.addPage([595, 842]);
    const T = (t, x, y, s = 10) => page.drawText(t, { x, y, size: s, font });
    T("FREE SALE CERTIFICATE", 180, 780, 16);
    T("PRODUCT NAME", 60, 700);
    T("PACKING SIZE", 260, 700);
    T("FORM", 420, 700);
    const listed = ["ADDMECTIN 1%", "SULFARIM", "OLIGOVET"];
    listed.forEach((n, k) => {
      T(n, 60, 676 - k * 22);
      T(k === 0 ? "100mL" : "1L", 260, 676 - k * 22);
      T("Liquid", 420, 676 - k * 22);
    });
    T("This certificate is valid for one year.", 60, 560);
    const fscType = await prisma.certificateType.create({ data: { companyId: co.id, code: "FSC", name: "Free Sale Certificate" } });
    const up = await createTemplateFromUpload({ companyId: co.id, userId: null, file: { buffer: Buffer.from(await fsc.save()), originalname: "ADDVET FSC.pdf" }, settings: { certificateTypeId: fscType.id, scope: "per_product", name: "ADDVET FSC" } });
    for (let k = 0; k < 60 && (await prisma.templateVersion.findUnique({ where: { id: up.versionId } })).status !== "draft"; k++) await sleep(1000);
    const ps = [];
    for (const n of listed) ps.push((await prisma.product.findFirst({ where: { companyId: co.id, name: n } })) || (await prisma.product.create({ data: { companyId: co.id, name: n, packaging: n === "ADDMECTIN 1%" ? "100mL" : "1L", physicalForm: "Liquid" } })));
    const b3 = await prisma.intakeBatch.create({ data: { ownerType: "user", ownerId: admin.id, companyId: co.id, status: "done", mode: "express", executedAt: new Date(), express: { requestedTypes: ["FSC"], stage: null } } });
    await prisma.intakeItem.create({ data: { batchId: b3.id, name: "ADDVET FSC.pdf", sizeBytes: 1, receivedBytes: 1, status: "done", companyId: co.id, classification: { docType: "certificate_filled", certCode: "FSC", productNames: listed }, result: { plan: { action: "certificate_both", companyId: co.id, productIds: ps.map((p) => p.id), certCode: "FSC" }, template: { code: "FSC", templateId: up.templateId, versionId: up.versionId, fields: { suggested: 0 } }, link: "" } } });
    let ex = null;
    for (const until = Date.now() + 300_000; Date.now() < until; ) {
      try {
        ex = await runExpress({ batchId: b3.id });
        break;
      } catch (err) {
        if (!err.retry) throw err;
        await sleep(1500);
      }
    }
    const t5 = Object.values(ex?.templates || {})[0];
    const tpl = await prisma.certificateTemplate.findUnique({ where: { id: up.templateId } });
    const groups = t5?.tableVersionId ? await prisma.templateGroup.findMany({ where: { versionId: t5.tableVersionId } }) : [];
    assert("the FSC is used (not «needs a person»): a product row, the template one certificate per order", t5?.status === "active" && groups.length === 1 && groups[0].source.kind === "invoice_lines" && tpl.scope === "per_invoice", { t5, scope: tpl.scope, lines: t5?.tableVersionId && (await prisma.templateVersion.findUnique({ where: { id: t5.tableVersionId }, select: { lines: true } }))?.lines?.map((l) => `${l.id}@${Math.round(l.box.x)},${Math.round(l.box.y)}:${l.text}`) });
    const certs = await prisma.certificate.findMany({ where: { companyId: co.id, certificateTypeId: fscType.id }, include: { items: true, versions: { orderBy: { versionNumber: "desc" }, take: 1 } } });
    const rows = certs[0]?.versions[0]?.values?.products?.rows || [];
    assert("ONE FSC certificate for the 3 products, linked to each", certs.length === 1 && certs[0].items.length === 3, certs.map((c) => c.items.length));
    const own = await prisma.product.findMany({ where: { id: { in: ps.map((p) => p.id) } }, select: { name: true, packaging: true, physicalForm: true } });
    assert("…its rows filled from each product's own name, pack and form (never the design's sample)", rows.length === 3 && own.every((p) => rows.some((r) => r.row_product_name === p.name && r.row_cell_2 === p.packaging && r.row_cell_3 === p.physicalForm)), { rows, own });
  } catch (err) {
    assert(`no crash: ${err.stack}`, false);
  } finally {
    await prisma.intakeBatch.deleteMany({ where: { companyId: co.id } }).catch(() => {});
    await prisma.assistantConversation.deleteMany({ where: { companyId: co.id } }).catch(() => {});
    await cleanupCompany(co.id).catch(() => {});
  }
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
