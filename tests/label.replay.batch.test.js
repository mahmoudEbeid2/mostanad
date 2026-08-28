// Phase 9: deterministic replay (§14.7) and Batch API (§9.8) wrapper.
// Only the pure logic is exercised here — `replay()` needs a live label row +
// a real Gemini call, and `createBatch()` is verified live to fail with
// 400 FAILED_PRECONDITION on this project's free-tier key (see
// batchClient.js's header comment and PROGRESS.md's Phase 9 entry).
import { idSetsDiffer, interpretReplay } from "../src/services/label/assurance/replayService.js";
import { isTerminalState, buildInlinedRequest, parseBatchResults, TERMINAL_STATES } from "../src/services/ai/batchClient.js";

const colors = { green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };
const log = (msg, color = "") => console.log(color ? `${colors[color]}${msg}${colors.reset}` : msg);
let passed = 0, failed = 0;
function assert(label, condition, details = "") {
  if (condition) { log(`  PASS: ${label}`, "green"); passed++; }
  else { log(`  FAIL: ${label}`, "red"); if (details) log(`     -> ${JSON.stringify(details)}`); failed++; }
}

function run() {
  log("\n=== Phase 9: replay + batch client (pure logic) ===\n", "bold");

  log("-- idSetsDiffer --", "cyan");
  assert("Identical id arrays -> no drift", idSetsDiffer(["a", "b"], ["b", "a"]) === false);
  assert("A dropped id -> drift", idSetsDiffer(["a", "b"], ["a"]) === true);
  assert("An added id -> drift", idSetsDiffer(["a"], ["a", "b"]) === true);
  assert("Two empty arrays -> no drift", idSetsDiffer([], []) === false);

  log("\n-- interpretReplay --", "cyan");
  assert(
    "No diff -> identical message",
    interpretReplay({ fieldsDiffered: [], referenceSetDrifted: false, ruleSetDrifted: false }) === "Output is identical to the stored label."
  );
  const driftMsg = interpretReplay({ fieldsDiffered: [{ path: "storage" }], referenceSetDrifted: true, ruleSetDrifted: false });
  assert("Diff + reference drift -> attributes to drift, not the model", driftMsg.includes("does not by itself indicate model drift"));
  const modelDriftMsg = interpretReplay({ fieldsDiffered: [{ path: "storage" }], referenceSetDrifted: false, ruleSetDrifted: false });
  assert("Diff + no drift -> flags real model non-determinism", modelDriftMsg.includes("real model non-determinism"));

  log("\n-- batchClient: isTerminalState --", "cyan");
  assert("SUCCEEDED is terminal", isTerminalState("JOB_STATE_SUCCEEDED") === true);
  assert("FAILED is terminal", isTerminalState("JOB_STATE_FAILED") === true);
  assert("CANCELLED is terminal", isTerminalState("JOB_STATE_CANCELLED") === true);
  assert("PARTIALLY_SUCCEEDED is terminal", isTerminalState("JOB_STATE_PARTIALLY_SUCCEEDED") === true);
  assert("RUNNING is not terminal", isTerminalState("JOB_STATE_RUNNING") === false);
  assert("QUEUED is not terminal", isTerminalState("JOB_STATE_QUEUED") === false);
  assert("PENDING is not terminal", isTerminalState("JOB_STATE_PENDING") === false);
  assert("Unknown/undefined state is not terminal", isTerminalState(undefined) === false);
  assert("Exactly 5 states are considered terminal", TERMINAL_STATES.size === 5);

  log("\n-- batchClient: buildInlinedRequest --", "cyan");
  const plain = buildInlinedRequest({ contents: "hello", temperature: 0.2 });
  assert("Plain request carries contents through", plain.contents === "hello");
  assert("Plain request has no responseSchema when none given", plain.config.responseSchema === undefined);
  assert("Temperature is threaded into config", plain.config.temperature === 0.2);
  assert("Default maxOutputTokens is 8192", plain.config.maxOutputTokens === 8192);
  assert("No metadata key when none given", !("metadata" in plain));

  const withSchema = buildInlinedRequest({ contents: "x", schema: { type: "object" }, thinkingBudget: 512, metadata: { caseId: "42" } });
  assert("responseMimeType is set when a schema is given", withSchema.config.responseMimeType === "application/json");
  assert("responseSchema is threaded through", withSchema.config.responseSchema.type === "object");
  assert("thinkingConfig.thinkingBudget is set when given", withSchema.config.thinkingConfig.thinkingBudget === 512);
  assert("metadata is preserved when given", withSchema.metadata.caseId === "42");

  log("\n-- batchClient: parseBatchResults --", "cyan");
  const fakeBatchJob = {
    dest: {
      inlinedResponses: [
        { metadata: { i: "0" }, response: { text: '{"ok":true}' } },
        { metadata: { i: "1" }, response: { text: "```json\n{\"ok\":false}\n```" } },
        { metadata: { i: "2" }, response: { text: "not json at all" } },
        { metadata: { i: "3" }, error: { code: 500, message: "internal" } },
      ],
    },
  };
  const results = parseBatchResults(fakeBatchJob);
  assert("Returns one entry per response", results.length === 4);
  assert("Plain JSON text is parsed", results[0].json?.ok === true);
  assert("Markdown-fenced JSON is unwrapped and parsed", results[1].json?.ok === false);
  assert("Non-JSON text falls back to .text with no .json", results[2].text === "not json at all" && results[2].json === undefined);
  assert("A per-item error is surfaced instead of a parse attempt", results[3].error?.code === 500);
  assert("Empty/missing dest.inlinedResponses yields an empty array", parseBatchResults({}).length === 0);

  log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`, failed === 0 ? "green" : "red");
  process.exit(failed > 0 ? 1 : 0);
}

run();
