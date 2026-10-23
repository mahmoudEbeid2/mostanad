// plan.md P8 — GET /ai-status: the UI says "AI unavailable" up front instead of
// letting each AI action fail. No Gemini call is made (helpers set GEMINI_DISABLED).
import { api, asAdmin, asCompany, makeAssert, finish, createCompany, cleanupCompany, prisma } from "./helpers.js";
import { getAiStatus } from "../../src/services/ai/aiStatus.js";

const { assert, counts } = makeAssert();
const co = await createCompany("p8s");
const saved = { disabled: process.env.GEMINI_DISABLED, key: process.env.GEMINI_API_KEY };

try {
  console.log("\n🔌 Status from configuration");
  let s = await getAiStatus();
  assert("GEMINI_DISABLED=true → unavailable (disabled), user-facing message", !s.available && s.reason === "disabled" && /works by hand/.test(s.message) && !/GEMINI/.test(s.message), s);
  process.env.GEMINI_DISABLED = "false";
  delete process.env.GEMINI_API_KEY;
  s = await getAiStatus();
  assert("no API key → unavailable (no_key)", !s.available && s.reason === "no_key", s);

  console.log("\n📉 Status from the run log (the key is shared by every company)");
  process.env.GEMINI_API_KEY = "test-key-not-used";
  const now = Date.now() + 60_000; // after any run other suites logged
  const run = (outcome, error, at) => prisma.aiRun.create({ data: { companyId: co.id, kind: "INVOICE_EXTRACT", modelId: "m", promptHash: "p", outcome, error, createdAt: new Date(at) } });
  await run("failed", "Gemini quota exhausted (daily/project limit, not per-minute) for m — retrying will not help until it resets.", now - 1000);
  s = await getAiStatus({ now });
  assert("latest real attempt hit the daily quota → unavailable (quota), since when", !s.available && s.reason === "quota" && !!s.since, s);
  s = await getAiStatus({ now: now + 7 * 3600_000 });
  assert("…only for a while: after the window the next action probes again", s.available, s);
  await run("disabled", "company switched AI off", now - 500);
  s = await getAiStatus({ now });
  assert("a call that was not made doesn't count as recovery", s.reason === "quota", s);
  await run("ok", null, now - 100);
  s = await getAiStatus({ now });
  assert("a later success → available again", s.available && s.reason === null, s);
  await run("failed", "Gemini API call failed for m (status 400): bad request", now);
  s = await getAiStatus({ now: now + 1 });
  assert("an ordinary failure isn't 'unavailable'", s.available, s);

  console.log("\n🌐 Route");
  let r = await api("GET", "/ai-status", asAdmin);
  assert("GET /ai-status → the server's status (dev:test runs with AI off)", r.status === 200 && r.data.data.available === false && r.data.data.reason === "disabled", r.data);
  r = await api("GET", "/ai-status", asCompany(co.id));
  assert("a company account may read it too", r.status === 200 && r.data.data.reason === "disabled", r.status);
} catch (e) {
  assert(`suite crashed: ${e.message}`, false, e.stack);
} finally {
  process.env.GEMINI_DISABLED = saved.disabled;
  if (saved.key === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = saved.key;
}

await finish(counts, () => cleanupCompany(co.id));
