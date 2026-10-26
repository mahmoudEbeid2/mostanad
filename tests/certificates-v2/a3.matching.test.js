// Certificate AI layers — Phase A3 product matching (plan.md §7).
// The model is a deterministic stand-in (npm test never calls a paid API);
// the live run is scripts/evalCertMatching.js (RUN_LIVE_GEMINI=1).
// Proven here:
//  - code checks: pack-size / strength contradictions; the alias step
//  - golden invoice: ≥ 95 % of lines correctly matched or correctly left for the user, ONE call
//  - 0 cross-tenant candidates; the prompt carries only the company's products (P6)
//  - adversarial picks refused: not a candidate, another tenant's product, an invented id
//  - a contradicted pick loses confidence (never auto-accepted)
//  - an alias is learned ONLY when a person explicitly asks ("remember this name", owner 2026-10-27):
//    never by an auto-accepted AI match, never by picking a product alone; who / when / which line is
//    recorded, and rows without a confirmation are never read → the same supplier's
//    next invoice matches with 0 AI calls
//  - AI off / down → candidates as before (P8); re-matching reuses answers (0 calls)
//  - API: confirm the AI pick (ai_confirmed), pick another (suggestion edited), tenancy
// Needs the guarded stack (npm run dev:test).
import { api, asCompany, makeAssert, finish, cleanupCompany, prisma } from "./helpers.js";
import { seedMatchingCompanies, runMatching, goldenMatchModel, loadInvoice, confirmAsExpected, GOLDEN } from "./matchingGoldenHarness.js";
import { matchLine } from "../../src/services/certificates/matching/productMatcher.js";
import { matchInvoice } from "../../src/services/certificates/matching/productMatcher.js";
import { sizesOf, percentsOf, contradictions } from "../../src/services/certificates/matching/aiMatcher.js";
import { confirmAlias, aliasMap } from "../../src/services/certificates/matching/productAliases.js";

const { assert, counts } = makeAssert();
const seed = await seedMatchingCompanies("a3a");
const cid = seed.company.id;
const A = asCompany(cid);
const F = asCompany(seed.foreign.id);
const P = seed.products;
const itemsOf = (invoiceId) => prisma.invoiceItem.findMany({ where: { invoiceId }, orderBy: { lineNo: "asc" } });

try {
  console.log("\n🧪 Code checks (§7)");
  assert("sizes: 1 KG = 1000 g, 500 GR = 500 g, 5 LT = 5000 ml, 100ML", sizesOf("DOXY 1 KG").join() === "g:1000" && sizesOf("500gr bag").join() === "g:500" && sizesOf("ADD (5 LT)").join() === "ml:5000" && sizesOf("100ML").join() === "ml:100");
  assert("mg is a strength, not a pack size; words aren't sizes", sizesOf("60 mg").length === 0 && sizesOf("Gold label").length === 0);
  assert("percents", percentsOf("Tylo 20 % / 4,8%").join() === "20,4.8");
  assert("invoice 1 KG vs product 500 G → contradiction", contradictions({ name: "DOXYPHARMA 1 KG" }, { name: "DOXYPHARMA 500G", packaging: "500 G" }).length === 1);
  assert("invoice 1 KG vs product 1KG → none", contradictions({ name: "DOXYPHARMA 1 KG" }, { name: "DOXYPHARMA 1KG", packaging: "1KG" }).length === 0);
  assert("different units (L vs KG) are not compared", contradictions({ name: "X 1 L" }, { name: "X", packaging: "1KG" }).length === 0);
  assert("strength 20 % vs 10 % → contradiction", contradictions({ name: "Tylo 20 %" }, { name: "TYLOPHARMA 10%", strength: "10%" }).length === 1);
  const cat = [{ id: "p1", name: "DOXYPHARMA 1KG", productCode: "D1" }, { id: "p2", name: "DOXYPHARMA 500G", productCode: "D5" }];
  let m = matchLine({ name: "Doxy one kilo", code: "D5" }, cat, { aliases: new Map([["doxy one kilo", "p1"]]) });
  assert("an alias is step 1 (before the exact code)", m.matchStatus === "matched" && m.matchMethod === "alias" && m.productId === "p1", m);
  m = matchLine({ name: "Doxy one kilo" }, cat, { aliases: new Map([["doxy one kilo", "gone"]]) });
  assert("an alias to a product the company doesn't have is ignored", m.matchStatus === "needs_match", m);
  m = matchLine({ name: "Doxypharma" }, cat);
  assert("ambiguous → ≤ 5 shown, ≤ 10 for the AI", m.matchCandidates.length <= 5 && m.aiCandidates.length === 2 && m.aiCandidates.length <= 10);

  console.log("\n🧪 Golden supplier invoice with a correct stand-in model (§7 acceptance)");
  const calls = [];
  let g = await runMatching(seed, 0, { generate: goldenMatchModel(0, seed, { calls }) });
  assert(`≥ 95 % correctly matched or correctly left (${g.score.correct}/${g.score.total})`, g.score.correct / g.score.total >= 0.95, g.score.perLine.filter((l) => !l.ok));
  assert("the two undecidable lines are left for the user", g.score.leftCorrectly === 2);
  assert("0 cross-tenant candidates", g.score.crossTenant === 0);
  assert("exactly ONE AI call for the invoice", calls.length === 1 && g.res.ai.calls === 1, g.res.ai);
  assert("the exact-code line never reaches the AI", !JSON.parse(calls[0].contents[1].slice(7)).lines.some((l) => l.code === "ADDE120"));
  assert("auto-accept off (§12 Q1) → AI picks wait as suggestions", g.res.ai.autoAccepted === 0 && g.res.ai.suggested === 8 && g.items.filter((i) => i.matchMethod === "ai_confirmed").length === 0, g.res.ai);
  const prompt = JSON.stringify(calls[0].contents);
  assert("the prompt has no other company's product (P6)", ![...seed.foreignIds].some((id) => prompt.includes(id)));
  assert("candidates carry key facts (form, strength)", calls[0].contents[1].includes('"keyFacts":{"form":"powder","strength":"50%"}'));
  const sug = await prisma.aiSuggestion.findFirst({ where: { companyId: cid, kind: "product_match", entityId: g.items[0].id } });
  assert("AiSuggestion with provenance (P7)", sug && sug.entityType === "invoice_item" && sug.modelId && sug.promptHash && sug.inputHash && sug.aiRunId && sug.proposal.productId === P["DOXYPHARMA 1KG"].id, sug);
  assert("shown first among the line's candidates, marked as the AI's", g.items[0].matchCandidates[0].productId === P["DOXYPHARMA 1KG"].id && g.items[0].matchCandidates[0].ai.suggestionId === sug.id);

  console.log("\n🧪 Re-matching reuses the answers (0 calls)");
  const again = [];
  let res = await matchInvoice(g.inv.id, { generate: goldenMatchModel(0, seed, { calls: again }) });
  assert("same lines, same candidates → 0 calls, same suggestions", again.length === 0 && res.ai.reused === 9 && res.ai.suggested === 8, res.ai);

  console.log("\n🧪 Adversarial picks (§7 code checks)");
  const advInv = await loadInvoice(cid, 0);
  const foreignId = [...seed.foreignIds][0];
  res = await matchInvoice(advInv.id, {
    generate: goldenMatchModel(0, seed, {
      override: (l) =>
        l.lineNo === 1 ? { productId: P["VITAMIN AD3E"].id, confidence: 0.99 } // a real product of the company, not this line's candidate
        : l.lineNo === 2 ? { productId: foreignId, confidence: 0.99 } // another tenant's
        : l.lineNo === 3 ? { productId: "00000000-0000-4000-8000-00000000dead", confidence: 0.99 } // invented
        : null,
    }),
  });
  let items = await itemsOf(advInv.id);
  const rej = await prisma.aiSuggestion.findMany({ where: { companyId: cid, kind: "product_match", entityId: { in: items.slice(0, 3).map((i) => i.id) } } });
  assert("not a candidate / another tenant's / invented → refused, nothing suggested", items.slice(0, 3).every((i) => !i.matchCandidates.some((c) => c.ai) && i.matchStatus === "needs_match") && rej.length === 3 && rej.every((s) => s.status === "rejected"), rej.map((s) => s.finalValue));
  assert("… the refusal says why", rej.every((s) => /candidates|catalogue/.test(s.finalValue.reason)));
  assert("another tenant's product never stored on a line", !items.some((i) => i.productId === foreignId || (i.matchCandidates || []).some((c) => c.productId === foreignId)));

  console.log("\n🧪 Contradictions lower the confidence; auto-accept only at/above the threshold");
  await api("PATCH", "/certificate-ai-settings", A, { autoAccept: true, autoAcceptThreshold: 0.9 });
  const autoInv = await loadInvoice(cid, 0);
  res = await matchInvoice(autoInv.id, { generate: goldenMatchModel(0, seed, { override: (l) => (l.lineNo === 1 ? { productId: l.candidates.find((c) => c.name === "DOXYPHARMA 500G").id, confidence: 0.95, reasons: ["same product"] } : null) }) });
  items = await itemsOf(autoInv.id);
  const doxy = items[0].matchCandidates.find((c) => c.ai);
  assert("1 KG line, AI picks the 500 G product at 0.95 → halved, not auto-accepted, warning shown", items[0].matchStatus === "needs_match" && doxy?.ai.confidence < 0.5 && doxy.ai.reasons.some((r) => /⚠ invoice says 1 KG, product is 500 G/.test(r)), doxy);
  assert("uncontradicted picks ≥ 0.9 → matched ai_confirmed", items.filter((i) => i.matchMethod === "ai_confirmed").length === 7 && res.ai.autoAccepted === 7, res.ai);
  assert("auto-accepted AI matches write NO alias (the AI never teaches the matcher)", (await prisma.productAlias.count({ where: { companyId: cid } })) === 0);
  const n = [];
  g = await runMatching(seed, 1, { generate: goldenMatchModel(1, seed, { calls: n }) });
  assert("the same supplier's next invoice: nothing by alias — its lines go to the AI again (1 call)", g.items.every((i) => i.matchMethod !== "alias") && n.length === 1 && JSON.parse(n[0].contents[1].slice(7)).lines.length >= 4, { methods: g.items.map((i) => i.matchMethod), calls: n.length });
  await api("PATCH", "/certificate-ai-settings", A, { autoAccept: false });
  await prisma.productAlias.deleteMany({ where: { companyId: cid } });

  console.log("\n🧪 A person confirms and asks to remember (API) → aliases → next invoice 0 calls");
  const inv1 = await loadInvoice(cid, 0);
  await matchInvoice(inv1.id, { generate: goldenMatchModel(0, seed) });
  items = await itemsOf(inv1.id);
  const pick = items[0].matchCandidates[0].ai;
  let r = await api("PATCH", `/invoices/${inv1.id}/items/${items[0].id}`, A, { productId: P["DOXYPHARMA 1KG"].id, aiSuggestionId: pick.suggestionId });
  assert("confirm the AI pick → matched, ai_confirmed", r.status === 200 && r.data.data.item.matchMethod === "ai_confirmed", r.data);
  assert("… suggestion accepted by that person's decision", (await prisma.aiSuggestion.findUnique({ where: { id: pick.suggestionId } })).status === "accepted");
  assert("… picking the product alone teaches nothing: no alias", (await prisma.productAlias.count({ where: { companyId: cid } })) === 0);
  await prisma.invoice.update({ where: { id: inv1.id }, data: { status: "ready" } });
  r = await api("PATCH", `/invoices/${inv1.id}/items/${items[0].id}`, A, { rememberAlias: true });
  const learned = await prisma.productAlias.findFirst({ where: { companyId: cid, aliasNorm: "doxypharma 1 kg" } });
  assert("“remember this name” → alias, confirmed, with the invoice line it came from", r.status === 200 && learned?.origin === "user_confirmed" && learned.confirmedAt && learned.sourceInvoiceId === inv1.id && learned.sourceInvoiceItemId === items[0].id && learned.productId === P["DOXYPHARMA 1KG"].id, learned);
  assert("… remembering changes nothing on the line, so the confirmed invoice stays confirmed", (await prisma.invoice.findUnique({ where: { id: inv1.id } })).status === "ready");
  await prisma.invoice.update({ where: { id: inv1.id }, data: { status: "review" } });
  r = await api("PATCH", `/invoices/${inv1.id}/items/${items[2].id}`, A, { rememberAlias: true });
  assert("remembering a line without a product → 409 NOTHING_TO_REMEMBER", r.status === 409 && r.data.code === "NOTHING_TO_REMEMBER", r.data);
  const pick2 = items[1].matchCandidates[0].ai;
  r = await api("PATCH", `/invoices/${inv1.id}/items/${items[1].id}`, A, { productId: P["DOXYPHARMA 1KG"].id });
  assert("choosing another product than the AI's → user match, suggestion recorded as edited", r.status === 200 && r.data.data.item.matchMethod === "user" && (await prisma.aiSuggestion.findUnique({ where: { id: pick2.suggestionId } })).status === "edited");
  r = await api("PATCH", `/invoices/${inv1.id}/items/${items[2].id}`, A, { productId: P["ADD-E120 5L"].id, aiSuggestionId: pick.suggestionId });
  assert("aiSuggestionId of another line → 404", r.status === 404, r.status);
  r = await api("PATCH", `/invoices/${inv1.id}/items/${items[2].id}`, F, { productId: P["ADD-E120 5L"].id });
  assert("another company → 404", r.status === 404, r.status);
  await confirmAsExpected(api, A, inv1.id, 0, seed);
  await api("PATCH", `/invoices/${inv1.id}/items/${items[1].id}`, A, { productId: P["DOXYPHARMA 500G"].id, rememberAlias: true }); // the person corrects line 2 and remembers it — the alias follows
  assert("a re-confirmation to another product replaces the alias", (await prisma.productAlias.findFirst({ where: { companyId: cid, aliasNorm: "doxypharma 500gr" } }))?.productId === P["DOXYPHARMA 500G"].id);
  r = await api("POST", `/invoices/${inv1.id}/rematch`, A);
  items = await itemsOf(inv1.id);
  assert("re-matching keeps confirmed lines (user / ai_confirmed)", r.status === 200 && items[0].matchMethod === "ai_confirmed" && items[1].matchMethod === "user", items.map((i) => i.matchMethod));
  const z = [];
  g = await runMatching(seed, 1, { generate: goldenMatchModel(1, seed, { calls: z }) });
  assert("second upload from the same supplier → 0 AI match calls, every line matched by alias, correctly", z.length === 0 && g.items.every((i) => i.matchMethod === "alias") && g.score.correct === g.score.total, g.score.perLine);
  assert("aliases never cross tenants", (await confirmAlias({ companyId: seed.foreign.id, name: "DOXYPHARMA 1 KG", productId: P["DOXYPHARMA 1KG"].id })) === null && (await prisma.productAlias.count({ where: { companyId: seed.foreign.id } })) === 0);
  // a row from before the rule (no confirmation) is never read
  await prisma.productAlias.create({ data: { companyId: cid, aliasNorm: "legacy auto name", productId: P["DOXYPHARMA 1KG"].id, origin: "ai_confirmed" } });
  assert("an alias nobody confirmed (legacy row) is never used by the matcher", !(await aliasMap(cid)).has("legacy auto name") && (await aliasMap(cid)).has("doxypharma 1 kg"));

  console.log("\n🧪 AI off / down → candidates as before (P8)");
  await prisma.productAlias.deleteMany({ where: { companyId: cid } });
  await api("PATCH", "/certificate-ai-settings", A, { allowAiMatching: false });
  const off = [];
  g = await runMatching(seed, 0, { generate: goldenMatchModel(0, seed, { calls: off }) });
  assert("matching off → no call, recorded as disabled, ranked candidates kept", off.length === 0 && g.res.ai.unavailable && (await prisma.aiRun.count({ where: { companyId: cid, kind: "CERT_PRODUCT_MATCH", outcome: "disabled" } })) >= 1 && g.items[0].matchCandidates.length > 0, g.res.ai);
  await api("PATCH", "/certificate-ai-settings", A, { allowAiMatching: true });
  const down = await loadInvoice(cid, 0);
  res = await matchInvoice(down.id, { generate: async () => { throw new Error("503 UNAVAILABLE overloaded"); } });
  items = await itemsOf(down.id);
  assert("model down → unavailable with the real message, candidates kept, nothing matched by AI", res.ai.unavailable && /503/.test(res.ai.reason) && items.every((i) => i.matchMethod !== "ai_confirmed") && items[0].matchCandidates.length > 0, res.ai);
  const later = [];
  res = await matchInvoice(down.id, { generate: goldenMatchModel(0, seed, { calls: later }) });
  assert("… asked again on the next match (a failure is not an answer)", later.length === 1 && res.ai.suggested === 8);
  r = await api("POST", `/invoices/${down.id}/rematch`, A);
  assert("API rematch (Gemini disabled in tests) → 200, reuses the answers (no call)", r.status === 200 && r.data.data.ai.calls === 0 && r.data.data.ai.reused === 9, r.data?.data?.ai);
  assert("golden fixture sanity", GOLDEN.invoices[0].lines.length === 11);
} finally {
  await finish(counts, async () => {
    for (const c of [cid, seed.foreign.id]) await cleanupCompany(c);
  });
}
