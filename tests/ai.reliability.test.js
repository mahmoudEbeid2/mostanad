// geminiClient reliability (2026-11-23): retry with backoff + jitter, Retry-After,
// timeouts, fallback to AI_MODEL_FALLBACK on repeated overload (logged on the
// ledger row), the per-model circuit breaker, the task → model map from env, the
// thinking-config translation for 3.x, and the prices the ledger stores.
// The SDK is a stub and the ledger write is captured: nothing reaches Google or
// the database.
process.env.GEMINI_DISABLED = "false";
if (!process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = "reliability-test-placeholder";
process.env.GEMINI_RPM = "100000"; // the shared limiter would space these stubbed calls 7.5 s apart
process.env.GEMINI_MAX_CONCURRENT = "4";
const savedEnv = { ...process.env };
delete process.env.AI_MODEL_DEFAULT;
delete process.env.AI_MODEL_FALLBACK;
delete process.env.AI_MODEL_ASSISTANT;

const { default: geminiClient, retryAfterMs } = await import("../src/services/ai/geminiClient.js");
const { __setLedgerWriteForTests } = await import("../src/services/ai/aiLedger.js");
const { MODELS, MODEL_IDS, DEFAULT_MODEL_ID, DEFAULT_FALLBACK_MODEL_ID, resolveModel, thinkingConfigFor, timeoutForFeature } = await import("../src/services/ai/modelRegistry.js");
const { MODEL_PRICES, priceAt, ratesFor, costUsd } = await import("../src/services/ai/modelPrices.js");
const { withAiContext } = await import("../src/services/ai/aiContext.js");
const { getAiModels } = await import("../src/services/ai/aiStatus.js");

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

const quiet = { error: console.error, log: console.log, warn: console.warn };
const mute = () => {
  console.error = () => {};
  console.log = () => {};
  console.warn = () => {};
};
const unmute = () => Object.assign(console, quiet);

const rows = [];
__setLedgerWriteForTests(async (data) => {
  rows.push(data);
  return data;
});
const savedAi = geminiClient._ai;
const USAGE = { promptTokenCount: 1000, cachedContentTokenCount: 0, candidatesTokenCount: 100, thoughtsTokenCount: 0 };
const failing = (status, message, extra = {}) => Object.assign(new Error(JSON.stringify({ error: { code: status, message, ...extra } })), { status });
const overloaded = () => failing(503, "This model is currently experiencing high demand. Spikes in demand are usually temporary.");
/** SDK stub: each step is an Error (thrown), "hang" (never answers) or undefined (answers); records every request */
function stub(steps) {
  const seen = [];
  let i = 0;
  geminiClient._ai = {
    models: {
      generateContent: async (req) => {
        seen.push({ model: req.model, config: req.config, at: Date.now() });
        const step = steps[i++];
        if (step === "hang") return new Promise(() => {});
        if (step instanceof Error) throw step;
        return { text: '{"ok":true}', usageMetadata: USAGE };
      },
    },
  };
  return seen;
}
const DEFAULT = DEFAULT_MODEL_ID;
const FALLBACK = DEFAULT_FALLBACK_MODEL_ID;
const FAST = { baseDelayMs: 5, maxDelayMs: 40, totalTimeMs: 5_000, breakerPauseMs: 60_000 };
const call = (extra = {}, retries = 5) =>
  withAiContext({ feature: "assistant.chat", entityType: "test", entityId: "reliability" }, () =>
    geminiClient.generateContentWithRetry({ model: DEFAULT, contents: "x", config: { thinkingConfig: { thinkingBudget: 0 } }, ...extra }, retries)
  );
async function attempt(fn) {
  rows.length = 0;
  mute();
  try {
    return { value: await fn() };
  } catch (error) {
    return { error };
  } finally {
    unmute();
  }
}

try {
  console.log("\n🧪 Task → model map (config only)");
  assert(`default model is ${MODEL_IDS.GEMINI_3_1_FLASH_LITE}, fallback ${MODEL_IDS.GEMINI_3_5_FLASH_LITE}`, DEFAULT === MODEL_IDS.GEMINI_3_1_FLASH_LITE && FALLBACK === MODEL_IDS.GEMINI_3_5_FLASH_LITE);
  assert("every task runs on the default when nothing overrides it", Object.values(MODELS).every((m) => m.id === DEFAULT), Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, m.id])));
  process.env.AI_MODEL_ASSISTANT = MODEL_IDS.GEMINI_3_8_FLASH;
  assert("AI_MODEL_ASSISTANT moves only the assistant", MODELS.ASSISTANT.id === MODEL_IDS.GEMINI_3_8_FLASH && MODELS.INVOICE_EXTRACT.id === DEFAULT && resolveModel("ASSISTANT") === MODEL_IDS.GEMINI_3_8_FLASH);
  const st = getAiModels();
  assert("status screen: the task's model, marked overridden; default and fallback with prices", st.tasks.find((t) => t.task === "ASSISTANT")?.overridden === true && st.default.modelId === DEFAULT && st.default.price?.inputPerMillion === 0.25 && st.fallback?.modelId === FALLBACK, st);
  delete process.env.AI_MODEL_ASSISTANT;
  process.env.AI_MODEL_DEFAULT = MODEL_IDS.GEMINI_2_5_FLASH;
  assert("AI_MODEL_DEFAULT moves every task", Object.values(MODELS).every((m) => m.id === MODEL_IDS.GEMINI_2_5_FLASH));
  process.env.AI_MODEL_DEFAULT = "not a model; rm -rf";
  mute();
  const bad = MODELS.EXTRACT.id;
  unmute();
  assert("a malformed AI_MODEL_DEFAULT is ignored (built-in default)", bad === DEFAULT, bad);
  delete process.env.AI_MODEL_DEFAULT;

  console.log("\n🧪 Thinking config per model family");
  assert("2.5: budget kept", JSON.stringify(thinkingConfigFor("gemini-2.5-flash", { thinkingBudget: 0 })) === '{"thinkingBudget":0}');
  const lv = (b) => thinkingConfigFor(DEFAULT, { thinkingBudget: b }).thinkingLevel;
  assert("3.x: 0 → minimal, 512 → low, 8192 → medium, 16384 / -1 → high (no thinkingBudget sent)", lv(0) === "minimal" && lv(512) === "low" && lv(8192) === "medium" && lv(16384) === "high" && lv(-1) === "high" && !("thinkingBudget" in thinkingConfigFor(DEFAULT, { thinkingBudget: 0 })));

  console.log("\n🧪 Retry: 503 then answered");
  geminiClient.setPolicy(FAST);
  let seen = stub([overloaded()]);
  let r = await attempt(() => call());
  assert("answered on the 2nd try, same model", !r.error && seen.length === 2 && seen.every((s) => s.model === DEFAULT), r.error?.message);
  assert("ledger: error (503) then ok, attempts 1-2", rows.map((x) => `${x.attempt}:${x.outcome}:${x.httpStatus}`).join(",") === "1:error:503,2:ok:null", rows.map((x) => `${x.attempt}:${x.outcome}:${x.httpStatus}`));
  assert("the 3.x request carries thinkingLevel, not thinkingBudget", seen[0].config.thinkingConfig?.thinkingLevel === "minimal" && seen[0].config.thinkingConfig.thinkingBudget === undefined, seen[0].config.thinkingConfig);
  assert("jittered backoff: a wait between the tries (≥ base/2)", seen[1].at - seen[0].at >= FAST.baseDelayMs / 2);

  console.log("\n🧪 Retry: 500 / 502 / 504 are retried, 400 is not");
  for (const status of [500, 502, 504]) {
    seen = stub([failing(status, "internal")]);
    r = await attempt(() => call());
    assert(`${status} → retried, answered`, !r.error && seen.length === 2);
  }
  seen = stub([failing(400, "Request contains an invalid argument.")]);
  r = await attempt(() => call());
  assert("400 → 1 request, fails with Google's message", r.error && seen.length === 1 && /status 400/.test(r.error.message) && /invalid argument/.test(r.error.message), r.error?.message);

  console.log("\n🧪 429 with Retry-After / RetryInfo");
  const withHeader = Object.assign(failing(429, "Resource has been exhausted (e.g. check quota)."), { headers: new Headers({ "retry-after": "0.3" }) });
  seen = stub([withHeader]);
  r = await attempt(() => call());
  const waited = seen[1] ? seen[1].at - seen[0].at : -1;
  assert(`Retry-After: 0.3 s honoured (waited ${waited} ms, backoff alone is ≤ 5 ms)`, !r.error && waited >= 280, waited);
  assert("retryAfterMs: seconds and an HTTP date", retryAfterMs({ headers: { "retry-after": "2" } }) === 2000 && retryAfterMs({ headers: { "retry-after": new Date(Date.now() + 3000).toUTCString() } }) > 1000 && retryAfterMs({}) === null);
  seen = stub([failing(429, "Quota exceeded per minute", { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.2s" }] })]);
  r = await attempt(() => call());
  assert("RetryInfo 0.2s honoured", !r.error && seen[1].at - seen[0].at >= 180);
  seen = stub([failing(429, "Quota exceeded for quota metric 'Generate Content API requests per day'", { details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] })]);
  r = await attempt(() => call());
  assert("daily quota → 1 request, no retry, no fallback, says so", r.error && seen.length === 1 && /daily\/project limit/.test(r.error.message));
  seen = stub([Object.assign(failing(429, "busy"), { headers: { "retry-after": "60" } })]);
  r = await attempt(() => call());
  assert("Retry-After beyond the total time limit → fails now instead of waiting past it", r.error && seen.length === 1 && /limit/.test(r.error.message), r.error?.message);

  console.log("\n🧪 Timeout");
  geminiClient.setPolicy({ ...FAST, timeoutMs: 60 });
  seen = stub(["hang"]);
  let t0 = Date.now();
  r = await attempt(() => call());
  assert(`a hung request is aborted after the timeout and retried (${Date.now() - t0} ms)`, !r.error && seen.length === 2 && Date.now() - t0 < 2000);
  assert("the abort signal is passed to the SDK", seen[0].config.abortSignal instanceof AbortSignal && seen[0].config.abortSignal.aborted);
  assert("ledger: the timed-out attempt is an error row with the timeout message", rows[0]?.outcome === "error" && /timed out after 60 ms/.test(rows[0].error), rows[0]);
  geminiClient.setPolicy(FAST);
  assert("per-task timeouts: assistant 60 s, regulatory 300 s, unknown 120 s", timeoutForFeature("assistant.chat") === 60_000 && timeoutForFeature("regulatory.compile") === 300_000 && timeoutForFeature("x") === 120_000);

  console.log("\n🧪 Fallback on repeated overload");
  seen = stub([overloaded(), overloaded()]);
  r = await attempt(() => call());
  assert("2 overloads on the default → 3rd try on the fallback, answered", !r.error && seen.map((s) => s.model).join(",") === [DEFAULT, DEFAULT, FALLBACK].join(","), seen.map((s) => s.model));
  assert("ledger: the fallback's row names its model and meta.routing { fallbackFrom, reason: overloaded }", rows[2]?.modelId === FALLBACK && rows[2]?.meta?.routing?.fallbackFrom === DEFAULT && rows[2]?.meta?.routing?.reason === "overloaded" && rows[0].meta?.routing === undefined, rows[2]);
  assert("the fallback gets its own thinking config", seen[2].config.thinkingConfig?.thinkingLevel === "minimal");
  const { modelUsed } = await import("../src/services/ai/geminiClient.js");
  assert("the response says which model answered (for provenance)", modelUsed(r.value, DEFAULT) === FALLBACK);
  seen = stub([overloaded(), overloaded(), overloaded(), overloaded()]);
  r = await attempt(() => call());
  assert("every try overloaded → 4 tries at most (2 default + 2 fallback), then fails", r.error && seen.length === 4 && /after 4 attempts/.test(r.error.message), r.error?.message);
  process.env.AI_MODEL_FALLBACK = DEFAULT;
  geminiClient.setPolicy(FAST);
  seen = stub([overloaded(), overloaded()]);
  r = await attempt(() => call());
  assert("fallback = default → no switch (fallback off)", !r.error && seen.every((s) => s.model === DEFAULT));
  delete process.env.AI_MODEL_FALLBACK;
  geminiClient.setPolicy(FAST);
  seen = stub([failing(500, "internal"), failing(500, "internal")]);
  r = await attempt(() => call());
  assert("500s are retried on the same model (not an overload)", !r.error && seen.every((s) => s.model === DEFAULT));

  console.log("\n🧪 Circuit breaker");
  geminiClient.setPolicy({ ...FAST, breakerThreshold: 3, fallbackAfterOverloads: 99 });
  seen = stub([overloaded(), overloaded(), overloaded()]);
  r = await attempt(() => call());
  assert("3 overloads in a row open the breaker on the default", geminiClient.breaker.isOpen(DEFAULT), geminiClient.breaker.snapshot());
  seen = stub([]);
  r = await attempt(() => call());
  assert("while open: the next call goes straight to the fallback (1 request)", !r.error && seen.length === 1 && seen[0].model === FALLBACK && rows[0]?.meta?.routing?.reason === "circuit_open", seen.map((s) => s.model));
  assert("status screen lists the paused model", getAiModels().paused.some((p) => p.model === DEFAULT));
  geminiClient.breaker.state(FALLBACK).openUntil = Date.now() + 60_000;
  seen = stub([]);
  r = await attempt(() => call());
  assert("both paused → fails at once, no request sent", r.error && seen.length === 0 && /paused/.test(r.error.message), r.error?.message);
  geminiClient.breaker.state(DEFAULT).openUntil = Date.now() - 1; // the minute is over
  geminiClient.breaker.state(FALLBACK).openUntil = 0;
  seen = stub([]);
  r = await attempt(() => call());
  assert("after the pause the default is tried again; success closes it", !r.error && seen[0].model === DEFAULT && !geminiClient.breaker.isOpen(DEFAULT));
  geminiClient.setPolicy(FAST);
  seen = stub([overloaded(), failing(400, "bad")]);
  r = await attempt(() => call());
  assert("an overload then a non-overload error does not open it", !geminiClient.breaker.isOpen(DEFAULT));

  console.log("\n🧪 Total time cap");
  geminiClient.setPolicy({ ...FAST, baseDelayMs: 800, maxDelayMs: 800, totalTimeMs: 300, fallbackAfterOverloads: 99 });
  seen = stub([failing(500, "internal"), failing(500, "internal")]);
  t0 = Date.now();
  r = await attempt(() => call());
  assert(`a wait that would pass the cap → fails after 1 try (${Date.now() - t0} ms)`, r.error && seen.length === 1 && /limit/.test(r.error.message), r.error?.message);
  geminiClient.setPolicy(FAST);
  seen = stub([failing(500, "x"), failing(500, "x"), failing(500, "x"), failing(500, "x"), failing(500, "x")]);
  r = await attempt(() => call({}, 2));
  assert("a caller's lower retries (2) still caps the tries", r.error && seen.length === 2);

  console.log("\n🧪 Prices in the ledger");
  seen = stub([]);
  r = await attempt(() => call());
  const want = (1000 * 0.25 + 100 * 1.5) / 1e6;
  assert(`default model row priced: $${want} (0.25 in / 1.50 out per 1M)`, Math.abs(rows[0].costUsd - want) < 1e-12 && rows[0].priceInputPerM === 0.25 && rows[0].priceOutputPerM === 1.5, rows[0]);
  seen = stub([overloaded(), overloaded()]);
  r = await attempt(() => call());
  const wantFb = (1000 * 0.3 + 100 * 2.5) / 1e6;
  assert(`fallback row priced at the fallback's rates: $${wantFb}`, Math.abs(rows[2].costUsd - wantFb) < 1e-12, rows[2]);
  seen = stub([]);
  r = await attempt(() => call({ config: { serviceTier: "flex" } }));
  assert("a Flex call is priced at the Flex rates and says so", Math.abs(rows[0].costUsd - want / 2) < 1e-12 && rows[0].meta?.serviceTier === "flex" && seen[0].config.serviceTier === "flex", rows[0]);
  for (const id of [DEFAULT, FALLBACK]) {
    const p = priceAt(id);
    assert(`${id} has a complete price`, Boolean(ratesFor(p)), p);
  }
  assert("gemini-3.8-flash doubles from 2027-01-01", priceAt(MODEL_IDS.GEMINI_3_8_FLASH, "2027-01-02").inputPerMillion === 2 * priceAt(MODEL_IDS.GEMINI_3_8_FLASH, "2026-12-31").inputPerMillion);
  assert("every priced model is a registry id", MODEL_PRICES.every((p) => Object.values(MODEL_IDS).includes(p.modelId)));
  assert("costUsd: cached tokens at the cached rate", Math.abs(costUsd({ inputTokens: 1000, cachedTokens: 400, outputTokens: 0 }, ratesFor(priceAt(DEFAULT))) - (600 * 0.25 + 400 * 0.025) / 1e6) < 1e-12);
} catch (e) {
  unmute();
  assert(`suite crashed: ${e.message}`, false, e.stack);
} finally {
  geminiClient._ai = savedAi;
  geminiClient.setPolicy();
  __setLedgerWriteForTests(null);
  for (const k of ["AI_MODEL_DEFAULT", "AI_MODEL_FALLBACK", "AI_MODEL_ASSISTANT"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
