import { prisma } from "../src/lib/prisma.js";
import { makeAssert, createCompany, api, asCompany } from "./certificates-v2/helpers.js";
import * as registry from "../src/services/assistant/registry/index.js";
import * as assistant from "../src/services/assistant/assistantService.js";
import * as actions from "../src/services/assistant/actions.js";
import * as drafts from "../src/services/assistant/drafts/draftService.js";
import { SPECS, specFor, unspecified } from "../src/services/assistant/drafts/specs.js";

// Operation drafts (slot filling): specs from the tools' own schemas, the collecting loop
// (context → lookup → the person), choices never picked by the model, prerequisite chains,
// one card from a ready draft, errors back to their field, expiry, tenant isolation.
// No Gemini call: the model is a script.

const { assert, counts } = makeAssert();
const s = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const companyActor = (c) => ({ kind: "company", id: c.id, name: c.name, companyId: c.id });
const call = (name, args) => ({ functionCall: { name, args } });
const script = (steps) => {
  const seen = [];
  return {
    seen,
    generate: async (req) => {
      seen.push(JSON.parse(JSON.stringify(req)));
      const step = steps[Math.min(seen.length - 1, steps.length - 1)];
      return { content: { role: "model", parts: typeof step === "function" ? step(req) : step }, usage: { promptTokenCount: 5, candidatesTokenCount: 1 } };
    },
  };
};
const lastUserText = (req) => JSON.stringify(req.contents.filter((c) => c.role === "user").at(-1));
const expectError = async (fn) => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
};

async function seed(c, tag) {
  const brand = await prisma.brand.create({ data: { name: `Nordvet ${tag}`, companyId: c.id } });
  const one = await prisma.brand.create({ data: { name: `Vet Brand One ${tag}`, companyId: c.id } });
  const two = await prisma.brand.create({ data: { name: `Vet Brand Two ${tag}`, companyId: c.id } });
  const category = await prisma.category.create({ data: { name: `Drafts Cat ${tag}` } });
  const product = await prisma.product.create({ data: { companyId: c.id, brandId: brand.id, name: `Vitaminol D${tag}`, productCode: `VD-${tag}` } });
  const invoice = await prisma.invoice.create({ data: { companyId: c.id, sourceFileId: crypto.randomUUID(), status: "review", header: { invoiceNumber: `DRF-${tag}` } } });
  await prisma.invoiceItem.create({ data: { invoiceId: invoice.id, lineNo: 1, data: { name: `Vitaminol D${tag}`, batchNo: "B-1" }, dataExtracted: {}, matchStatus: "needs_match" } });
  // an active template, so Generate has something to plan
  const type = await prisma.certificateType.create({ data: { companyId: c.id, name: `COA ${tag}`, code: `D${tag.slice(-5)}` } });
  const template = await prisma.certificateTemplate.create({ data: { companyId: c.id, certificateTypeId: type.id, name: `COA ${tag}`, scope: "per_product" } });
  const version = await prisma.templateVersion.create({ data: { templateId: template.id, versionNumber: 1, status: "active", sourceFormat: "html", sourceFileId: crypto.randomUUID() } });
  await prisma.certificateTemplate.update({ where: { id: template.id }, data: { activeVersionId: version.id } });
  return { brand, one, two, category, product, invoice, type, template };
}

async function main() {
  console.log("🧪 Assistant — operation drafts\n");
  const cA = await createCompany(`drA${s}`);
  const cB = await createCompany(`drB${s}`);
  const tagA = `a${s}`;
  const A = await seed(cA, tagA);
  const B = await seed(cB, `b${s}`);
  const actorA = companyActor(cA);
  const actorB = companyActor(cB);
  for (const c of [cA, cB]) await assistant.updateSettings(c.id, { enabled: true, messagesPerUserPerHour: 500, modelCallsPerDay: 5000 });
  const categories = [A.category.id, B.category.id];

  // a session as sendMessage builds it (cards through proposeAction)
  const envFor = (actor, conversationId, userTexts = [], page = null) => ({
    actor,
    scope: { companyId: actor.companyId },
    page,
    conversationId,
    userTexts,
    companyExists: async (id) => !!(await prisma.company.findUnique({ where: { id } })),
  });

  try {
    // ── 1. specs ────────────────────────────────────────────────────────────
    console.log("Specs");
    assert("every write tool has a spec (one source: the tool's own schema)", unspecified().length === 0, unspecified());
    const bad = [];
    for (const [name, spec] of Object.entries(SPECS)) {
      const shape = registry.getTool(name)?.args.shape || {};
      for (const f of [...Object.keys(spec.fields), ...(spec.alsoRequire || []), ...(spec.key || [])]) if (!(f in shape)) bad.push(`${name}.${f}`);
    }
    assert("a spec names only fields its tool's schema has", bad.length === 0, bad);
    const cp = specFor("create_product");
    assert("create_product's fields are the products API validator's (POST /products), minus companyId", cp.fields.some((f) => f.name === "activeIngredients" && f.type === "array") && !cp.fields.some((f) => f.name === "companyId") && cp.fields.find((f) => f.name === "name").required);
    assert("a field's resolution is declared: page, lookup tool, or user", specFor("match_invoice_line").fields.find((f) => f.name === "productId").how[0] === "lookup (search_products)" && specFor("generate_certificates").fields.find((f) => f.name === "invoiceId").how[0] === "page");

    // ── 2. a multi-turn flow: 5 fields from context + lookup + the person, executed once ──
    console.log("\nCollecting across turns");
    const conv = await assistant.createConversation(actorA);
    const name = `Vita Max ${tagA}`;
    let m = script([[call("start_draft", { tool: "create_product", values: [{ field: "name", value: name }], hints: [{ field: "brandId", text: `Nordvet ${tagA}` }] })], [{ text: "Which category, and what is its composition?" }]]);
    const t1 = await assistant.sendMessage(actorA, conv.id, { text: `Add a product named ${name} for brand Nordvet ${tagA}` }, { generate: m.generate });
    const draftId = t1.message.toolCalls[0].draftId;
    let d = (await drafts.conversationDrafts(actorA, conv.id)).find((x) => x.id === draftId);
    const f = (view, n) => view.fields.find((x) => x.name === n);
    assert("turn 1: company from the context, name from the person's words, brand from a lookup", d.companyId === cA.id && f(d, "name").source === "user" && f(d, "brandId").source === "lookup" && f(d, "brandId").value === A.brand.id, d.fields);
    assert("…still missing: category and composition; the composition is asked, the category is a choice", d.status === "collecting" && d.missing.includes("categoryId") && d.missing.includes("activeIngredients") && d.ask.some((x) => x.name === "activeIngredients" && x.type === "ingredients"), { missing: d.missing, ask: d.ask });
    assert("the model is told what to ask, all in one message", JSON.stringify(m.seen[1].contents.at(-1)).includes("ALL in ONE short message"));
    assert("…and no card yet", t1.message.actions.length === 0);
    m = script([
      (req) => {
        const id = /\[open drafts: ([0-9a-f-]{36})/.exec(lastUserText(req))?.[1];
        return [call("update_draft", { draftId: id, values: [{ field: "activeIngredients", value: JSON.stringify([{ name: "Vitamin C", concentration: "10%" }]) }], hints: [{ field: "categoryId", text: `Drafts Cat ${tagA}` }] })];
      },
      [{ text: "Here is the card to add it." }],
    ]);
    const t2 = await assistant.sendMessage(actorA, conv.id, { text: `Category Drafts Cat ${tagA}, composition Vitamin C 10%` }, { generate: m.generate });
    assert("turn 2: the open draft is in the model's context and resumed by id", t2.message.toolCalls[0].draftId === draftId);
    const card = t2.message.actions[0];
    d = (await drafts.conversationDrafts(actorA, conv.id)).find((x) => x.id === draftId);
    assert("ready → ONE card with every value and its source", d.status === "ready" && card?.draftId === draftId && card.preview.fields.length === 5 && card.preview.fields[0].source === "context" && card.preview.fields.every((x) => x.source), card?.preview.fields);
    assert("sources: context (company) · lookup (brand, category) · user (name, composition)", f(d, "categoryId").source === "lookup" && f(d, "activeIngredients").source === "user" && f(d, "name").source === "user");
    const ran = await actions.approveAction(actorA, card.id);
    const made = await prisma.product.findMany({ where: { companyId: cA.id, name } });
    assert("Run executes exactly the confirmed draft, once", ran.status === "done" && made.length === 1 && made[0].brandId === A.brand.id && made[0].categoryId === A.category.id && made[0].activeIngredients?.[0]?.name === "Vitamin C", made[0]);
    d = (await drafts.conversationDrafts(actorA, conv.id)).find((x) => x.id === draftId);
    assert("…and the draft is executed, with the messages that worked on it", d.status === "executed" && (await prisma.assistantDraft.findUnique({ where: { id: draftId } })).messageIds.length === 2);
    const auditRows = await prisma.assistantToolCall.findMany({ where: { conversationId: conv.id, tool: "draft:create_product" } });
    assert("every draft change is in the audit log (field, value, source, by)", auditRows.filter((r) => r.status === "draft_set").length >= 5 && auditRows.some((r) => r.args.field === "companyId" && r.args.source === "context") && auditRows.some((r) => r.status === "draft_status" && r.args.to === "executed") && auditRows.some((r) => r.args.field === "brandId" && r.args.source === "lookup"), auditRows.map((r) => [r.status, r.args.field]));

    // ── 3. an ambiguous lookup is a choice, never picked by the model ─────────
    console.log("\nChoices");
    const conv2 = await assistant.createConversation(actorA);
    const sess = drafts.draftSession(envFor(actorA, conv2.id, [`add Vet Product ${tagA}`]));
    let v = await sess.open({ tool: "create_product", values: { name: `Vet Product ${tagA}` }, hints: { brandId: `Vet Brand` } });
    const brandField = f(v, "brandId");
    assert("several brands match → a choice for the person, nothing filled", brandField.value === undefined && brandField.options?.length === 2 && v.ask.some((x) => x.name === "brandId" && x.type === "choice"), brandField);
    v = await sess.update(v.id, { values: { brandId: A.one.id } });
    assert("the model picking one of the options is rejected", f(v, "brandId").value === undefined && v.rejected?.some((r) => r.field === "brandId" && /choice for the person/.test(r.reason)), v.rejected);
    v = await drafts.submitDraftFields(actorA, v.id, { brandId: A.two.id });
    assert("the person's choice in the form fills it (source: you typed)", f(v, "brandId").value === A.two.id && f(v, "brandId").source === "user" && f(v, "brandId").confirmed);
    const sess2 = drafts.draftSession(envFor(actorA, conv2.id, [`add Other Product ${tagA}`]));
    const v2 = await sess2.open({ tool: "create_product", values: { name: `Other Product ${tagA}`, brandId: A.one.id }, hints: { brandId: "Vet Brand" } });
    assert("an id the model passes with a name code finds ambiguous → not accepted; the person chooses", f(v2, "brandId").value === undefined && f(v2, "brandId").options?.length === 2 && v2.rejected?.some((r) => r.field === "brandId"), { brand: f(v2, "brandId"), rejected: v2.rejected });

    // ── 4. a prerequisite chain: not matched → match → confirm → generate ──
    console.log("\nPrerequisites");
    const conv3 = await assistant.createConversation(actorA);
    const page = { entityType: "invoice", entityId: A.invoice.id };
    const env3 = { ...envFor(actorA, conv3.id, ["generate the certificates"], page) };
    const s3 = drafts.draftSession(env3);
    let gen = await s3.open({ tool: "generate_certificates" });
    assert("generate: the invoice from the page; blocked by the unmatched line and the unconfirmed invoice, each with its fix", f(gen, "invoiceId").source === "context" && gen.blockedBy.map((b) => b.key).join() === "lines_matched,invoice_ready" && gen.blockedBy[0].fix.includes("match_invoice_line") && gen.blockedBy[1].fix.includes("confirm_invoice") && !gen.actionId, gen.blockedBy);
    const match = await s3.open({ tool: "match_invoice_line" });
    assert("match: invoice from the page, the only open line, the product by the line's printed name (exact) — ready", match.status === "ready" && f(match, "lineNo").value === 1 && f(match, "productId").value === A.product.id && /exact match/.test(f(match, "productId").evidence), match.fields);
    await actions.approveAction(actorA, match.actionId);
    gen = await s3.update(gen.id);
    assert("after the match, generate is blocked only by the confirmation", gen.blockedBy.map((b) => b.key).join() === "invoice_ready", gen.blockedBy);
    const confirm = await s3.open({ tool: "confirm_invoice" });
    assert("confirm: its own draft, ready", confirm.status === "ready");
    await actions.approveAction(actorA, confirm.actionId);
    gen = await s3.update(gen.id);
    assert("…then generate is ready with its card", gen.status === "ready" && gen.blockedBy.length === 0 && gen.action?.status === "pending", { status: gen.status, blockedBy: gen.blockedBy, error: gen.error });

    // ── 5. a validation error maps back to its field ─────────────────────────
    console.log("\nErrors back to their field");
    const conv4 = await assistant.createConversation(actorA);
    const s4 = drafts.draftSession(envFor(actorA, conv4.id, [`add Err Product ${tagA} composition Zinc 5%`]));
    const tmpBrand = await prisma.brand.create({ data: { name: `Temp Brand ${tagA}`, companyId: cA.id } });
    let e = await s4.open({ tool: "create_product", values: { name: `Err Product ${tagA}`, activeIngredients: [{ name: "Zinc", concentration: "5%" }] }, hints: { brandId: `Temp Brand ${tagA}`, categoryId: `Drafts Cat ${tagA}` } });
    assert("ready", e.status === "ready", e);
    await prisma.brand.delete({ where: { id: tmpBrand.id } });
    const failed = await actions.approveAction(actorA, e.actionId);
    e = (await drafts.conversationDrafts(actorA, conv4.id))[0];
    assert("the API refuses (brand gone) → the draft collects again with Brand marked, the card failed", failed.status === "failed" && e.status === "collecting" && /brand/i.test(f(e, "brandId").error || "") && e.missing.includes("brandId") && failed.result.fields.includes("brandId"), { status: e.status, brand: f(e, "brandId"), result: failed.result });
    const lineBad = await s3.open({ tool: "create_product_from_line", values: { lineNo: "seven" } });
    assert("a value that doesn't fit is rejected with the reason, never coerced", lineBad.rejected?.some((r) => r.field === "lineNo" && /not a number/.test(r.reason)));

    // ── 6. no execute without a ready, confirmed draft ───────────────────────
    console.log("\nNo write without a ready draft");
    const loose = await actions.proposeAction({ conversationId: conv4.id, messageId: null, actor: actorA, tool: "create_product", args: { name: "Loose" }, companyId: cA.id, preview: { title: "x" } });
    let err = await expectError(() => actions.approveAction(actorA, loose.id));
    assert("a card with no draft behind it is refused", err?.statusCode === 409 && /ready draft/.test(err.message) && !(await prisma.product.findFirst({ where: { companyId: cA.id, name: "Loose" } })));
    const exec = await registry.runTool("execute_draft", { draftId: e.id }, { actor: actorA, scope: { companyId: cA.id }, conversationId: conv4.id });
    assert("the model has no tool that executes", exec.status === "refused");
    const collectingCard = await actions.proposeAction({ conversationId: conv4.id, messageId: null, actor: actorA, tool: "create_product", args: { name: "Again" }, companyId: cA.id, preview: { title: "x" }, draftId: e.id });
    err = await expectError(() => actions.approveAction(actorA, collectingCard.id));
    assert("a card whose draft is still collecting is refused", err?.statusCode === 409);

    // ── 7. arguments changed after confirmation ──────────────────────────────
    console.log("\nChanged after the card");
    const conv5 = await assistant.createConversation(actorA);
    const s5 = drafts.draftSession(envFor(actorA, conv5.id, [`set storage to Dry place ${tagA}`]));
    let up = await s5.open({ tool: "update_product_fields", values: { productId: A.product.id, changes: [{ field: "storage", value: `Dry place ${tagA}` }] } });
    const row = await prisma.assistantDraft.findUnique({ where: { id: up.id } });
    await prisma.assistantDraft.update({ where: { id: up.id }, data: { fields: { ...row.fields, changes: { ...row.fields.changes, value: [{ field: "storage", value: "Hot place" }] } } } });
    err = await expectError(() => actions.approveAction(actorA, up.actionId));
    assert("the draft's values changed after the card → refused, nothing written", err?.statusCode === 409 && /changed/.test(err.message) && (await prisma.product.findUnique({ where: { id: A.product.id } })).storage !== "Hot place", err?.message);
    const s5b = drafts.draftSession(envFor(actorA, conv5.id, [`set storage to Cool ${tagA}`]));
    const oldCard = up.actionId;
    up = await s5b.update(up.id, { values: { changes: [{ field: "storage", value: `Cool ${tagA}` }] } });
    assert("a change through the draft retires the old card and shows a new one", up.actionId !== oldCard && (await prisma.assistantAction.findUnique({ where: { id: oldCard } })).status === "cancelled" && up.status === "ready");

    // ── 8. expiry ────────────────────────────────────────────────────────────
    console.log("\nExpiry");
    await prisma.assistantDraft.update({ where: { id: up.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    err = await expectError(() => actions.approveAction(actorA, up.actionId));
    assert("24 h after its last change the draft expires; its card is refused (410)", err?.statusCode === 410 && (await prisma.assistantDraft.findUnique({ where: { id: up.id } })).status === "expired");
    const conv6 = await assistant.createConversation(actorA);
    const s6 = drafts.draftSession(envFor(actorA, conv6.id, [`set storage to Shade ${tagA}`]));
    const w = await s6.open({ tool: "update_product_fields", values: { productId: A.product.id, changes: [{ field: "storage", value: `Shade ${tagA}` }] } });
    await prisma.product.update({ where: { id: A.product.id }, data: { dosage: "changed elsewhere" } });
    err = await expectError(() => actions.approveAction(actorA, w.actionId));
    assert("what it acts on changed after the card was shown → expired, refused", err?.statusCode === 410 && (await prisma.assistantDraft.findUnique({ where: { id: w.id } })).status === "expired", err?.message);

    const conv9 = await assistant.createConversation(actorA);
    const s9 = drafts.draftSession(envFor(actorA, conv9.id, []));
    const stale = await s9.open({ tool: "update_product_fields", values: { productId: A.product.id } });
    await prisma.assistantDraft.update({ where: { id: stale.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const fresh = await s9.open({ tool: "update_product_fields", values: { productId: A.product.id } });
    assert("an expired draft is never revived: the same operation starts a new one", fresh.id !== stale.id && fresh.status === "collecting" && (await prisma.assistantDraft.findUnique({ where: { id: stale.id } })).status === "expired");

    // ── 9. tenant isolation ──────────────────────────────────────────────────
    console.log("\nTenants");
    err = await expectError(() => drafts.submitDraftFields(actorB, draftId, { name: "x" }));
    assert("another company can't fill my draft (404)", err?.statusCode === 404);
    err = await expectError(() => drafts.cancelDraft(actorB, d.id));
    assert("…or cancel it (404)", err?.statusCode === 404);
    const convB = await assistant.createConversation(actorB);
    err = await expectError(() => drafts.draftSession(envFor(actorB, convB.id)).update(gen.id, {}));
    assert("…or resume it from its own conversation (404)", err?.statusCode === 404);
    const sb = await drafts.draftSession(envFor(actorB, convB.id, [])).open({ tool: "match_invoice_line", values: { invoiceId: A.invoice.id, productId: A.product.id } });
    assert("company A's ids in company B's draft are rejected", sb.rejected.some((r) => r.field === "invoiceId") && sb.rejected.some((r) => r.field === "productId") && f(sb, "invoiceId").value === undefined);
    assert("company B lists none of A's drafts", (await drafts.conversationDrafts(actorB, conv.id)).length === 0);
    let res = await api("POST", `/assistant/drafts/${draftId}/fields`, asCompany(cB.id), { values: { name: "x" } });
    assert("over the API too (404)", res.status === 404, res.data);
    const conv7 = await assistant.createConversation(actorA);
    const s7 = await drafts.draftSession(envFor(actorA, conv7.id, [])).open({ tool: "create_product" });
    res = await api("POST", `/assistant/drafts/${s7.id}/fields`, asCompany(cA.id), { values: { name: `Form Product ${tagA}` } });
    assert("the form card over the API: the person's value fills the field", res.status === 200 && res.data.data.draft.fields.find((x) => x.name === "name").value === `Form Product ${tagA}`, res.data);
    res = await api("POST", `/assistant/drafts/${s7.id}/cancel`, asCompany(cA.id));
    assert("cancel over the API", res.status === 200 && res.data.data.draft.status === "cancelled");
    res = await api("GET", `/assistant/conversations/${conv7.id}/drafts`, asCompany(cA.id));
    assert("a conversation's drafts over the API", res.status === 200 && res.data.data.drafts.some((x) => x.id === s7.id));

    // ── 10. a model that invents a required value ───────────────────────────
    console.log("\nInvented values");
    const conv8 = await assistant.createConversation(actorA);
    m = script([[call("create_product", { name: "Invented Name", activeIngredients: [{ name: "Zinc", concentration: "5%" }], brandId: A.brand.id })], [{ text: "Card ready." }]]);
    const inv = await assistant.sendMessage(actorA, conv8.id, { text: "add a product please" }, { generate: m.generate });
    const di = (await drafts.conversationDrafts(actorA, conv8.id))[0];
    assert("a name and a composition the person never said stay missing; no card", f(di, "name").value === undefined && f(di, "activeIngredients").value === undefined && di.missing.includes("name") && inv.message.actions.length === 0, { fields: di.fields.map((x) => [x.name, x.value]), rejected: di.rejected });
    assert("…the model is told they were rejected and to ask", JSON.stringify(m.seen[1].contents.at(-1)).includes("Not in the person's messages"));
    assert("…while the brand id (from a lookup) is kept", f(di, "brandId").value === A.brand.id);
  } finally {
    await prisma.assistantConversation.deleteMany({ where: { ownerId: { in: [cA.id, cB.id] } } });
    await prisma.assistantSetting.deleteMany({ where: { scopeKey: { in: [cA.id, cB.id] } } });
    for (const c of [cA, cB]) {
      await prisma.invoiceItem.deleteMany({ where: { invoice: { companyId: c.id } } });
      await prisma.invoice.deleteMany({ where: { companyId: c.id } });
      await prisma.templateVersion.deleteMany({ where: { template: { companyId: c.id } } }).catch(() => {});
      await prisma.certificateTemplate.updateMany({ where: { companyId: c.id }, data: { activeVersionId: null } });
      await prisma.templateVersion.deleteMany({ where: { template: { companyId: c.id } } });
      await prisma.certificateTemplate.deleteMany({ where: { companyId: c.id } });
      await prisma.certificateType.deleteMany({ where: { companyId: c.id } });
      await prisma.product.deleteMany({ where: { companyId: c.id } });
      await prisma.brand.deleteMany({ where: { companyId: c.id } });
      await prisma.company.delete({ where: { id: c.id } }).catch((e) => console.log(`  (cleanup: ${e.message})`));
    }
    await prisma.category.deleteMany({ where: { id: { in: categories } } });
    await prisma.$disconnect();
  }
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  process.exit(counts.failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
