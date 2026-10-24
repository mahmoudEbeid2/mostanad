// AI cost ledger: every Gemini attempt → exactly one ai_calls row, priced at
// call time, thinking billed as output, every report tenant-scoped.
// The SDK is stubbed in this process (nothing is sent to Google); the report
// routes are exercised against the dev:test API.
import fs from "fs";
import path from "path";
import { api, asAdmin, asCompany, makeAssert, finish, createCompany, cleanupCompany, prisma } from "./helpers.js";
import geminiClient from "../../src/services/ai/geminiClient.js";
import { FEATURES, __setPriceTableForTests, recordAttempt, linkTaskCalls } from "../../src/services/ai/aiLedger.js";
import { withAiContext, withAiJobContext, aiRequestContext, setAiActor } from "../../src/services/ai/aiContext.js";
import { MODEL_PRICES, priceAt, ratesFor, costUsd } from "../../src/services/ai/modelPrices.js";
import { MODELS, MODEL_IDS } from "../../src/services/ai/modelRegistry.js";
import { runLogged } from "../../src/services/certificates/ai/aiRunLog.js";
import { classifyIntent, answerQuestion, proposePatch } from "../../src/services/label/editing/chatAgent.js";
import { audit } from "../../src/services/label/validation/adversarialAuditor.js";
import { auditDocument } from "../../src/services/label/regulatory/coverageAuditor.js";
import { compile } from "../../src/services/label/regulatory/ruleCompiler.js";
import { extractTextAndCatalog } from "../../src/services/label/regulatory/catalogExtractor.js";

const { assert, counts } = makeAssert();
const FLASH = MODEL_IDS.GEMINI_2_5_FLASH;
const near = (a, b) => a !== null && a !== undefined && Math.abs(Number(a) - b) < 1e-12;
const savedDisabled = process.env.GEMINI_DISABLED;
const savedAi = geminiClient._ai;
const quiet = { error: console.error, log: console.log };
const mute = () => {
  console.error = () => {};
  console.log = () => {};
};
const unmute = () => {
  console.error = quiet.error;
  console.log = quiet.log;
};

// prices used by this test only: A until 2026-06-01, then B
const TABLE = [
  { modelId: FLASH, effectiveFrom: "2025-01-01", inputPerMillion: 0.3, cachedInputPerMillion: 0.075, outputPerMillion: 2.5, longContext: null },
  { modelId: FLASH, effectiveFrom: "2026-06-01", inputPerMillion: 1, cachedInputPerMillion: 0.25, outputPerMillion: 4, longContext: null },
];
const USAGE = { promptTokenCount: 1000, cachedContentTokenCount: 200, candidatesTokenCount: 100, thoughtsTokenCount: 50 };
const COST_B = (800 * 1 + 200 * 0.25 + (100 + 50) * 4) / 1e6; // thinking billed as output
const COST_A = (800 * 0.3 + 200 * 0.075 + (100 + 50) * 2.5) / 1e6;

const okSdk = (text = "{}") => ({ models: { generateContent: async () => ({ text, usageMetadata: USAGE }) } });
const failing = (status, message) => Object.assign(new Error(message), { status });
const quota429 = (scope, delay = "0.01s") =>
  failing(429, JSON.stringify({ error: { code: 429, message: `Quota exceeded for requests ${scope}`, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }] } }));
/** an SDK that fails with each given error in turn, then answers */
const sequence = (...errors) => {
  let i = 0;
  return { models: { generateContent: async () => (i < errors.length ? Promise.reject(errors[i++]) : { text: "{}", usageMetadata: USAGE }) } };
};

const co = await createCompany("ledger");
const coB = await createCompany("ledger-b");
let marker = 0;
const rowsFor = (entityId) => prisma.aiCall.findMany({ where: { entityId }, orderBy: [{ createdAt: "asc" }, { attempt: "asc" }] });
/** runs fn as one tagged scenario; returns its ledger rows */
async function scenario(fn, ctx = {}) {
  const entityId = `ledger-test-${Date.now()}-${++marker}`;
  mute();
  try {
    await withAiContext({ companyId: co.id, feature: "labels.chat", entityType: "test", entityId, ...ctx }, fn);
  } catch (_) {
    // the outcome under test is the rows written; the call's own error is expected in failure scenarios
  } finally {
    unmute();
  }
  return { entityId, rows: await rowsFor(entityId) };
}
const call = (retries = 1, extra = {}) => geminiClient.generateContentWithRetry({ model: FLASH, contents: "x", ...extra }, retries);

try {
  __setPriceTableForTests(TABLE);
  process.env.GEMINI_DISABLED = "false";

  console.log("\n🧪 One row per attempt, at the choke point");
  process.env.GEMINI_DISABLED = "true";
  let s = await scenario(() => call());
  assert("blocked by the guard → no row (nothing was sent)", s.rows.length === 0, s.rows.length);
  process.env.GEMINI_DISABLED = "false";

  geminiClient._ai = okSdk();
  s = await scenario(() => call(), { userId: "u-1" });
  const r0 = s.rows[0];
  assert("answered → exactly 1 row, attempt 1, ok", s.rows.length === 1 && r0.attempt === 1 && r0.outcome === "ok" && r0.httpStatus === null, s.rows);
  assert("row carries company, user, feature, entity, model", r0.companyId === co.id && r0.userId === "u-1" && r0.feature === "labels.chat" && r0.entityType === "test" && r0.modelId === FLASH, r0);
  assert("tokens: input (cached included), cached, output, thinking", r0.inputTokens === 1000 && r0.cachedTokens === 200 && r0.outputTokens === 100 && r0.thinkingTokens === 50, r0);
  assert("latency recorded (≥ 0)", r0.latencyMs >= 0);
  assert(`thinking tokens billed as output: cost = ${COST_B} (without them it would be ${(800 + 50 + 400) / 1e6})`, near(r0.costUsd, COST_B), Number(r0.costUsd));
  assert("the price used is stored on the row (B, effective 2026-06-01)", r0.priceEffectiveFrom?.toISOString().startsWith("2026-06-01") && Number(r0.priceInputPerM) === 1 && Number(r0.priceCachedPerM) === 0.25 && Number(r0.priceOutputPerM) === 4, r0);

  s = await scenario(() => geminiClient.generateJson({ model: FLASH, contents: "x", schema: { type: "OBJECT" } }, 1));
  assert("generateJson → exactly 1 row", s.rows.length === 1 && s.rows[0].outcome === "ok", s.rows.length);
  s = await scenario(() => geminiClient.generateText({ model: FLASH, contents: "x" }, 1));
  assert("generateText → exactly 1 row", s.rows.length === 1 && s.rows[0].outcome === "ok", s.rows.length);

  geminiClient._ai = sequence(failing(400, "Request contains an invalid argument."));
  s = await scenario(() => call(3));
  assert("400 (not retried) → 1 row, outcome error, status 400, no tokens, cost 0", s.rows.length === 1 && s.rows[0].outcome === "error" && s.rows[0].httpStatus === 400 && s.rows[0].inputTokens === 0 && near(s.rows[0].costUsd, 0), s.rows);

  geminiClient._ai = sequence(quota429("per minute"), quota429("per minute"));
  s = await scenario(() => call(3));
  assert(
    "429 per-minute ×2 then answered → 3 rows: quota, quota, ok (attempts 1-3)",
    s.rows.length === 3 && s.rows.map((r) => `${r.attempt}:${r.outcome}`).join(",") === "1:quota,2:quota,3:ok",
    s.rows.map((r) => `${r.attempt}:${r.outcome}:${r.httpStatus}`)
  );

  geminiClient._ai = sequence(quota429("per day"));
  s = await scenario(() => call(5));
  assert("429 daily quota (not retried) → 1 row, outcome quota", s.rows.length === 1 && s.rows[0].outcome === "quota" && s.rows[0].httpStatus === 429, s.rows);

  geminiClient._ai = sequence(failing(503, "The model is overloaded."));
  s = await scenario(() => call(2));
  assert("503 then answered → 2 rows: error (503), ok", s.rows.length === 2 && s.rows[0].outcome === "error" && s.rows[0].httpStatus === 503 && s.rows[1].outcome === "ok" && s.rows[1].attempt === 2, s.rows.map((r) => `${r.attempt}:${r.outcome}:${r.httpStatus}`));

  console.log("\n🧪 Price in effect at call time");
  assert("priceAt: the latest entry not after the date", priceAt(FLASH, "2026-01-15", TABLE) === TABLE[0] && priceAt(FLASH, "2026-06-01T00:00:00Z", TABLE) === TABLE[1] && priceAt(FLASH, "2024-12-31", TABLE) === null);
  const longTier = { inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 2, longContext: { aboveInputTokens: 200_000, inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 4 } };
  assert("long-context tier above its threshold, base tier at or below", ratesFor(longTier, 250_000).inputPerMillion === 2 && ratesFor(longTier, 200_000).inputPerMillion === 1);
  assert("a missing rate → unpriced (null), never 0", ratesFor({ inputPerMillion: 1, cachedInputPerMillion: null, outputPerMillion: 2 }) === null && costUsd({ inputTokens: 10 }, null) === null);

  const old = await withAiContext({ companyId: co.id, feature: "labels.chat", entityType: "test", entityId: "ledger-past" }, () =>
    recordAttempt({ modelId: FLASH, attempt: 1, ok: true, usage: USAGE, latencyMs: 5, at: new Date("2026-01-15T12:00:00Z") })
  );
  assert("a call made on 2026-01-15 is priced with A (then in effect)", near(old.costUsd, COST_A) && old.priceEffectiveFrom.toISOString().startsWith("2025-01-01"), Number(old.costUsd));
  // a price change: a new entry from today (C)
  const today = new Date().toISOString().slice(0, 10);
  __setPriceTableForTests([...TABLE, { modelId: FLASH, effectiveFrom: today, inputPerMillion: 10, cachedInputPerMillion: 1, outputPerMillion: 20, longContext: null }]);
  geminiClient._ai = okSdk();
  s = await scenario(() => call());
  const COST_C = (800 * 10 + 200 * 1 + 150 * 20) / 1e6;
  assert("after the change, a new call is priced with C", near(s.rows[0]?.costUsd, COST_C), Number(s.rows[0]?.costUsd));
  const reread = await prisma.aiCall.findUnique({ where: { id: r0.id } });
  const rereadOld = await prisma.aiCall.findUnique({ where: { id: old.id } });
  assert("the change rewrote no earlier row (B and A costs and prices unchanged)", near(reread.costUsd, COST_B) && Number(reread.priceInputPerM) === 1 && near(rereadOld.costUsd, COST_A));
  __setPriceTableForTests(TABLE);

  const unpriced = await withAiContext({ companyId: co.id, feature: "labels.chat", entityType: "test", entityId: "ledger-unpriced" }, () => recordAttempt({ modelId: "some-other-model", attempt: 1, ok: true, usage: USAGE }));
  assert("a model with no price → row kept, costUsd null (unpriced)", unpriced && unpriced.costUsd === null && unpriced.inputTokens === 1000);

  console.log("\n🧪 Prices live in one file");
  const modelIds = [...new Set(Object.values(MODELS).map((m) => m.id))];
  assert("every model the registry uses has a price entry (numbers may still be null)", modelIds.every((id) => MODEL_PRICES.some((p) => p.modelId === id)), modelIds);
  const srcFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) srcFiles.push(p);
    }
  };
  walk(path.join(process.cwd(), "src"));
  const priceLiteral = /\b\w*(price|perM\b|perMillion|PerM\b)\w*\s*[:=]\s*(num\([^)]*,\s*)?\d/i;
  const offenders = srcFiles.filter((f) => !f.endsWith(`ai${path.sep}modelPrices.js`) && fs.readFileSync(f, "utf8").split("\n").some((l) => priceLiteral.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/Decimal|@db/.test(l)));
  assert("no price literal anywhere in src except modelPrices.js (CERT_AI_PRICE_* gone)", offenders.length === 0 && !srcFiles.some((f) => fs.readFileSync(f, "utf8").includes("CERT_AI_PRICE_")), offenders.map((f) => path.relative(process.cwd(), f)));

  console.log("\n🧪 Every call path is tagged and writes its row");
  const sites = [];
  for (const f of srcFiles) {
    if (f.endsWith(`ai${path.sep}geminiClient.js`)) continue;
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/geminiClient\.(generateJson|generateText|generateContentWithRetry)\(/g)) {
      const after = text.slice(m.index, m.index + 200);
      const feature = (after.match(/ledger: \{ feature: "([^"]+)" \}/) || [])[1];
      sites.push({ file: path.relative(process.cwd(), f), feature });
    }
  }
  assert(`all ${sites.length} geminiClient call sites in src pass a known feature (≥ 27)`, sites.length >= 27 && sites.every((x) => FEATURES.includes(x.feature)), sites.filter((x) => !FEATURES.includes(x.feature)));
  const areas = new Set(sites.map((x) => x.feature.split(".")[0]));
  assert("labels, regulatory, catalogue, certificates and products are all covered", ["labels", "regulatory", "catalogue", "certificates", "products"].every((a) => areas.has(a)), [...areas]);

  geminiClient._ai = okSdk();
  const realPaths = [
    ["labels.chat", "chatAgent.classifyIntent", () => classifyIntent("hello")],
    ["labels.chat", "chatAgent.answerQuestion", () => answerQuestion("why?", { labelData: {}, report: null })],
    ["labels.chat", "chatAgent.proposePatch", () => proposePatch("add cattle", { labelData: {}, report: null })],
    ["labels.audit", "adversarialAuditor.audit", () => audit({}, { rules: [] })],
    ["regulatory.coverage", "coverageAuditor.auditDocument", () => auditDocument("Article 1. Text.", [])],
    ["regulatory.compile", "ruleCompiler.compile", () => compile("Article 1. Text.", { title: "t", authority: "a", country: "EG" })],
    ["regulatory.ingest", "catalogExtractor.extractTextAndCatalog", () => extractTextAndCatalog({ inlineData: { mimeType: "application/pdf", data: "JVBERi0=" } }, { title: "t", authority: "a", country: "EG" })],
  ];
  for (const [feature, name, fn] of realPaths) {
    // feature comes from the call site itself: the context here deliberately carries none
    s = await scenario(fn, { feature: null });
    assert(`${name} → exactly 1 row, feature ${feature}`, s.rows.length === 1 && s.rows[0].feature === feature && s.rows[0].companyId === co.id, s.rows.map((r) => r.feature));
  }

  console.log("\n🧪 Context: certificate operations, jobs, requests");
  let runRow = null;
  s = await scenario(async () => {
    const out = await runLogged({ companyId: co.id, kind: "CERT_FIELD_MAP", promptHash: "p", input: {}, entityType: "template_version", entityId: `tv-${marker}` }, () => geminiClient.generateJson({ model: FLASH, contents: "x", ledger: { feature: "certificates.mapping" } }, 1));
    runRow = out.run;
  }, { feature: null, entityType: null, entityId: null });
  const viaRun = await prisma.aiCall.findMany({ where: { aiRunId: runRow?.id } });
  assert("runLogged: the row points at its ai_runs row, with company, feature and entity", viaRun.length === 1 && viaRun[0].companyId === co.id && viaRun[0].feature === "certificates.mapping" && viaRun[0].entityType === "template_version", viaRun);

  const taskId = `task-${Date.now()}`;
  mute();
  await withAiJobContext({ data: { companyId: co.id, createdByUserId: "u-job", taskId } }, () => geminiClient.generateText({ model: FLASH, contents: "x", ledger: { feature: "labels.generation" } }, 1));
  unmute();
  const jobRows = await prisma.aiCall.findMany({ where: { entityType: "background_task", entityId: taskId } });
  assert("a BullMQ job: billed to the job's company and user, entity = its task", jobRows.length === 1 && jobRows[0].companyId === co.id && jobRows[0].userId === "u-job", jobRows);
  const labelId = `label-${Date.now()}`;
  await linkTaskCalls(taskId, "label", labelId);
  const linked = await prisma.aiCall.findUnique({ where: { id: jobRows[0].id } });
  assert("linkTaskCalls: the task's rows now point at the label; cost untouched", linked.parentType === "label" && linked.parentId === labelId && near(linked.costUsd, Number(jobRows[0].costUsd)));

  const reqMarker = `req-${Date.now()}`;
  mute();
  await new Promise((resolve) =>
    aiRequestContext({}, {}, async () => {
      setAiActor({ companyId: co.id, userId: "u-req" });
      await geminiClient.generateJson({ model: FLASH, contents: "x", ledger: { feature: "labels.chat", entityType: "test", entityId: reqMarker } }, 1).catch(() => {});
      resolve();
    })
  );
  unmute();
  const reqRows = await rowsFor(reqMarker);
  assert("an HTTP request: billed to the caller set by protect", reqRows.length === 1 && reqRows[0].companyId === co.id && reqRows[0].userId === "u-req", reqRows);

  s = await scenario(() => geminiClient.generateText({ model: FLASH, contents: "x", ledger: { feature: "regulatory.compile", companyId: coB.id } }, 1));
  assert("a call site's own values win over the context (company, feature)", s.rows.length === 1 && s.rows[0].companyId === coB.id && s.rows[0].feature === "regulatory.compile", s.rows);
  await prisma.aiCall.deleteMany({ where: { companyId: coB.id } });
} catch (e) {
  unmute();
  assert(`ledger suite crashed: ${e.message}`, false, e.stack);
} finally {
  geminiClient._ai = savedAi;
  process.env.GEMINI_DISABLED = savedDisabled;
  __setPriceTableForTests(null);
}

// ── reports over the API: tenancy ───────────────────────────────────────────
console.log("\n🧪 Reports: totals, top 20, per entity, CSV — tenant-scoped");
const DAY = 86_400_000;
const at = (daysAgo) => new Date(Date.now() - daysAgo * DAY);
let billedBefore = null;
const MONTH = (() => {
  const d = new Date();
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 35, 15));
  return { key: `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`, mid: m };
})();
try {
  await prisma.aiCall.deleteMany({ where: { companyId: { in: [co.id, coB.id] } } });
  const file = await prisma.storedFile.create({ data: { companyId: co.id, kind: "invoice_source", path: `certificates/${co.id}/none.pdf`, mimeType: "application/pdf", sizeBytes: 1, sha256: "x" } });
  const inv = await prisma.invoice.create({ data: { companyId: co.id, status: "review", sourceFileId: file.id, header: {} } });
  const type = await prisma.certificateType.create({ data: { companyId: co.id, name: "COA", code: "COA" } });
  const tpl = await prisma.certificateTemplate.create({ data: { companyId: co.id, certificateTypeId: type.id, name: "T" } });
  const v1 = await prisma.templateVersion.create({ data: { templateId: tpl.id, versionNumber: 1, sourceFormat: "pdf", sourceFileId: file.id } });
  const v2 = await prisma.templateVersion.create({ data: { templateId: tpl.id, versionNumber: 2, sourceFormat: "pdf", sourceFileId: file.id } });
  const cat = await prisma.catalogue.create({ data: { companyId: co.id, manufacturer: "M" } });
  const cv = await prisma.catalogueVersion.create({ data: { catalogueId: cat.id, companyId: co.id, label: "2026", sourceFileId: file.id } });

  const row = (companyId, feature, costUsd, extra = {}) => ({ companyId, feature, modelId: FLASH, attempt: 1, outcome: "ok", inputTokens: 100, outputTokens: 10, thinkingTokens: 5, costUsd, createdAt: at(1), ...extra });
  const data = [
    row(co.id, "certificates.invoice", 0.01, { entityType: "invoice", entityId: inv.id, aiRunId: "run-inv" }),
    row(co.id, "certificates.invoice", 0.002, { entityType: "invoice", entityId: inv.id, aiRunId: "run-inv", attempt: 2, outcome: "quota", inputTokens: 0, outputTokens: 0, thinkingTokens: 0, costUsd: 0 }),
    row(co.id, "certificates.web_lookup", 0.003, { entityType: "product", entityId: "p-1", parentType: "invoice", parentId: inv.id }),
    row(co.id, "certificates.mapping", 0.004, { entityType: "template_version", entityId: v1.id, createdAt: at(3) }),
    row(co.id, "certificates.mapping", 0.005, { entityType: "template_version", entityId: v2.id }),
    row(co.id, "catalogue.extract", 0.02, { entityType: "catalogue_version", entityId: cv.id }),
    row(co.id, "labels.generation", null, { entityType: "background_task", entityId: "t-unpriced" }),
    // 25 small operations, so the top list must cut at 20
    ...Array.from({ length: 25 }, (_, i) => row(co.id, "labels.chat", 0.0001 * (i + 1), { entityType: "label", entityId: `l-${i}` })),
    row(coB.id, "labels.generation", 7, { entityType: "invoice", entityId: inv.id }), // B's row, even naming A's invoice
    row(coB.id, "regulatory.compile", 3),
    // the reconciliation month (35 months ago — before the ledger existed, so nothing else is there)
    row(co.id, "labels.chat", 1.25, { createdAt: MONTH.mid }),
    row(coB.id, "labels.chat", 0.5, { createdAt: MONTH.mid }),
  ];
  await prisma.aiCall.createMany({ data });
  const aSum = data.filter((d) => d.companyId === co.id && d.createdAt > at(30)).reduce((a, d) => a + (d.costUsd ?? 0), 0);
  const A = asCompany(co.id);

  let r = await api("GET", "/ai-costs/summary", A);
  let sm = r.data?.data?.summary;
  assert("company: summary totals are its own rows only", r.status === 200 && near(sm.totals.costUsd, Math.round(aSum * 1e8) / 1e8) && sm.byCompany.length === 1 && sm.byCompany[0].companyId === co.id, sm?.totals);
  assert("company: unpriced and failed attempts counted", sm.totals.unpricedAttempts === 1 && sm.totals.failedAttempts === 1, sm.totals);
  assert("summary: per feature / model / day", sm.byFeature.find((f) => f.feature === "catalogue.extract")?.costUsd === 0.02 && sm.byModel[0].modelId === FLASH && sm.byDay.length === 2, { f: sm.byFeature.length, d: sm.byDay });
  assert("summary: thinking tokens summed", sm.totals.thinkingTokens === data.filter((d) => d.companyId === co.id && d.createdAt > at(30)).reduce((a, d) => a + d.thinkingTokens, 0), sm.totals.thinkingTokens);
  r = await api("GET", `/ai-costs/summary?companyId=${coB.id}`, A);
  assert("company: naming another company changes nothing (still its own)", r.status === 200 && r.data.data.summary.byCompany.every((c) => c.companyId === co.id) && !r.data.data.summary.byFeature.some((f) => f.feature === "regulatory.compile"));
  r = await api("GET", "/ai-costs/summary", asAdmin);
  const all = r.data?.data?.summary;
  assert("system user, no company: every company", r.status === 200 && [co.id, coB.id].every((id) => all.byCompany.some((c) => c.companyId === id)), all?.byCompany?.map((c) => c.companyId));
  r = await api("GET", `/ai-costs/summary?companyId=${coB.id}`, asAdmin);
  assert("system user naming one company: only that one", r.status === 200 && r.data.data.summary.byCompany.length === 1 && near(r.data.data.summary.totals.costUsd, 10));
  r = await api("GET", "/ai-costs/summary?from=2026-02-01&to=2026-01-01", A);
  assert("from after to → 400", r.status === 400);

  r = await api("GET", "/ai-costs/top", A);
  const ops = r.data?.data?.operations || [];
  assert("top: 20 operations by default, most expensive first, its own only", ops.length === 20 && ops[0].feature === "catalogue.extract" && ops.every((o) => o.companyId === co.id) && ops.every((o, i) => i === 0 || o.costUsd <= ops[i - 1].costUsd), ops.map((o) => `${o.feature}:${o.costUsd}`).slice(0, 4));
  assert("top: one ai_runs operation = its attempts together", ops.find((o) => o.aiRunId === "run-inv")?.attempts === 2);
  r = await api("GET", "/ai-costs/top?limit=100", asAdmin);
  assert("top: system user sees the other company's operation (7 USD) first", r.data?.data?.operations?.[0]?.companyId === coB.id);

  r = await api("GET", `/ai-costs/entity?type=invoice&id=${inv.id}`, A);
  let c = r.data?.data?.cost;
  assert("invoice cost end to end: its own 2 attempts + the web lookup made for it (0.013), not B's row", r.status === 200 && near(c.costUsd, 0.013) && c.attempts === 3, c);
  r = await api("GET", `/ai-costs/entity?type=template&id=${tpl.id}`, A);
  assert("template cost: every version (0.004 + 0.005)", r.status === 200 && near(r.data.data.cost.costUsd, 0.009) && r.data.data.cost.attempts === 2, r.data?.data?.cost);
  r = await api("GET", `/ai-costs/entity?type=catalogue&id=${cat.id}`, A);
  assert("catalogue cost: every edition (0.02)", r.status === 200 && near(r.data.data.cost.costUsd, 0.02), r.data?.data?.cost);
  r = await api("GET", `/ai-costs/entity?type=invoice&id=${inv.id}`, asCompany(coB.id));
  assert("another company's invoice → 404", r.status === 404, r.status);
  r = await api("GET", `/ai-costs/entity?type=template&id=${tpl.id}`, asCompany(coB.id));
  assert("another company's template → 404", r.status === 404, r.status);
  r = await api("GET", `/ai-costs/entity?type=invoice&id=${inv.id}`, asAdmin);
  assert("system user may read any entity's cost", r.status === 200);

  const csv = async (headers, q = "") => {
    const res = await fetch(`http://127.0.0.1:3000/api/v1/ai-costs/export.csv${q}`, { headers });
    return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
  };
  let e = await csv(A);
  const lines = e.text.trim().split("\n");
  assert("CSV: text/csv, header + one line per attempt, its own only", e.status === 200 && /text\/csv/.test(e.type) && lines[0].startsWith("createdAt,companyId,companyName") && lines.length - 1 === data.filter((d) => d.companyId === co.id && d.createdAt > at(30)).length && !e.text.includes(coB.id), { lines: lines.length });
  e = await csv(A, `?companyId=${coB.id}`);
  assert("CSV: a company naming another still gets its own", !e.text.includes(coB.id));
  e = await csv(asAdmin, `?companyId=${coB.id}`);
  assert("CSV: system user filtered to one company", e.text.trim().split("\n").length - 1 === 2 && !e.text.includes(co.id));

  console.log("\n🧪 Reconciliation");
  billedBefore = await prisma.aiBillingMonth.findUnique({ where: { month: MONTH.key } });
  r = await api("PUT", `/ai-costs/reconciliation/${MONTH.key}`, asAdmin, { billedUsd: 2, note: "test" });
  assert("enter the Google Cloud amount for a month", r.status === 200 && r.data.data.month.billedUsd === 2, r.data);
  r = await api("GET", "/ai-costs/reconciliation?months=36", asAdmin);
  const m = r.data?.data?.months?.find((x) => x.month === MONTH.key);
  assert("month: ledger total (all companies 1.75), billed 2, difference 0.25", m && near(m.ledgerUsd, 1.75) && m.billedUsd === 2 && near(m.differenceUsd, 0.25), m);
  r = await api("PUT", "/ai-costs/reconciliation/2026-13", asAdmin, { billedUsd: 1 });
  assert("a bad month → 400", r.status === 400);
  r = await api("PUT", `/ai-costs/reconciliation/${MONTH.key}`, asAdmin, { billedUsd: -1 });
  assert("a negative amount → 400", r.status === 400);
} catch (e) {
  assert(`reports suite crashed: ${e.message}`, false, e.stack);
} finally {
  if (billedBefore) await prisma.aiBillingMonth.update({ where: { month: MONTH.key }, data: { billedUsd: billedBefore.billedUsd, note: billedBefore.note } });
  else await prisma.aiBillingMonth.deleteMany({ where: { month: MONTH.key } });
  await finish(counts, async () => {
    await prisma.aiCall.deleteMany({ where: { companyId: { in: [co.id, coB.id] } } });
    for (const id of [co.id, coB.id]) await cleanupCompany(id);
  });
}
