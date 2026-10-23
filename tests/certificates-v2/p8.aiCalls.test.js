// plan.md P8 — "AI calls" counts requests that actually reached the provider.
// A request that went out and failed (400, 503 retries) is a call; one the
// guard blocked (GEMINI_DISABLED) is not. The SDK is stubbed: nothing is sent.
import { makeAssert, finish } from "./helpers.js";
import geminiClient from "../../src/services/ai/geminiClient.js";
import { withGenerationMetrics, generationMetricsSnapshot } from "../../src/services/ai/generationMetrics.js";

const { assert, counts } = makeAssert();
const savedDisabled = process.env.GEMINI_DISABLED;
const savedAi = geminiClient._ai;
const quiet = { error: console.error, log: console.log };

async function callsFor(fn) {
  return withGenerationMetrics(async () => {
    try {
      await fn();
    } catch (_) {
      // the outcome is asserted through the metrics; the error itself is expected
    }
    return generationMetricsSnapshot().geminiCalls;
  });
}
const sdkThatFails = (status, message) => ({ models: { generateContent: async () => { throw Object.assign(new Error(message), { status }); } } });

try {
  console.error = () => {};
  console.log = () => {};
  process.env.GEMINI_DISABLED = "true";
  const blocked = await callsFor(() => geminiClient.generateContentWithRetry({ model: "m", contents: "x" }, 1));
  process.env.GEMINI_DISABLED = "false";
  geminiClient._ai = sdkThatFails(400, "Request contains an invalid argument.");
  const rejected = await callsFor(() => geminiClient.generateContentWithRetry({ model: "m", contents: "x" }, 3));
  geminiClient._ai = sdkThatFails(503, "The model is overloaded.");
  const busy = await callsFor(() => geminiClient.generateContentWithRetry({ model: "m", contents: "x" }, 2));
  geminiClient._ai = { models: { generateContent: async () => ({ text: "{}", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }) } };
  const ok = await callsFor(() => geminiClient.generateContentWithRetry({ model: "m", contents: "x" }, 1));
  console.error = quiet.error;
  console.log = quiet.log;

  assert("blocked by the guard → 0 calls (nothing was sent)", blocked === 0, blocked);
  assert("sent and refused (400, not retried) → 1 call", rejected === 1, rejected);
  assert("sent twice, busy both times (503 retry) → 2 calls", busy === 2, busy);
  assert("sent and answered → 1 call", ok === 1, ok);
} catch (e) {
  console.error = quiet.error;
  console.log = quiet.log;
  assert(`suite crashed: ${e.message}`, false, e.stack);
} finally {
  geminiClient._ai = savedAi;
  process.env.GEMINI_DISABLED = savedDisabled;
}

await finish(counts);
