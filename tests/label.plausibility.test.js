// §14.5.7 layer 6 (plausibility). Uses injected fake judgeFn/resolveFn
// throughout — no real Gemini call, no network, safe to run on any key
// (including an exhausted one). What's under test is the STRUCTURAL
// guarantee (buildVerdict cannot produce PASS/FAIL) and the corrected
// status discriminator (source-keyed, not severity-keyed), both of which
// live entirely in code these fakes exercise the same way the real
// geminiClient/knowledgeResolver calls would.
import { buildVerdict, assessPlausibility, run } from "../src/services/label/validation/plausibilityValidator.js";

const colors = { green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };
const log = (msg, color = "") => console.log(color ? `${colors[color]}${msg}${colors.reset}` : msg);
let passed = 0, failed = 0;
function assert(label, condition, details = "") {
  if (condition) { log(`  PASS: ${label}`, "green"); passed++; }
  else { log(`  FAIL: ${label}`, "red"); if (details) log(`     -> ${JSON.stringify(details)}`); failed++; }
}

log("\n=== §14.5.7 Layer 6: plausibility ===\n", "bold");

// ── Correction 1: status keyed off SOURCE, not severity ─────────────────────
log("-- Status discriminator (source-keyed, not severity-keyed) --", "cyan");
{
  const v = buildVerdict("x", "a cited, minor note", { plausibilitySource: "external", citation: "EMA SPC" });
  assert("external source -> WARN, regardless of how minor the message reads", v.status === "WARN", v);
}
{
  const v = buildVerdict("x", "an alarming, uncited claim of impossibility", { plausibilitySource: "model_knowledge" });
  assert("model_knowledge source -> NEEDS_REVIEW, regardless of how alarming the message reads", v.status === "NEEDS_REVIEW", v);
}
{
  let threw = false;
  try { buildVerdict("x", "msg", { plausibilitySource: "severe" }); } catch { threw = true; }
  assert("An invalid plausibilitySource throws rather than silently defaulting", threw);
}

// ── Structural guarantee: no PASS/FAIL is reachable ─────────────────────────
log("\n-- Structural ceiling: never PASS, never FAIL --", "cyan");
{
  const externalStatus = buildVerdict("x", "m", { plausibilitySource: "external" }).status;
  const modelStatus = buildVerdict("x", "m", { plausibilitySource: "model_knowledge" }).status;
  assert("The only two reachable statuses are WARN and NEEDS_REVIEW", ["WARN", "NEEDS_REVIEW"].includes(externalStatus) && ["WARN", "NEEDS_REVIEW"].includes(modelStatus));
  assert("Neither reachable status is PASS", externalStatus !== "PASS" && modelStatus !== "PASS");
  assert("Neither reachable status is FAIL", externalStatus !== "FAIL" && modelStatus !== "FAIL");
}
{
  const v = buildVerdict("withdrawalPeriod", "unsourced concern", { plausibilitySource: "model_knowledge" });
  assert("Plausibility never proposes a value (remediation.suggested is always null)", v.remediation.suggested === null);
}

// ── assessPlausibility: two-stage flow ──────────────────────────────────────
log("\n-- Two-stage assessment (judge -> resolve) --", "cyan");
{
  const notSuspicious = await assessPlausibility({
    fieldPath: "x", judgePrompt: "p", knowledgeKind: "k", lookupKey: "l",
    judgeFn: async () => ({ suspicious: false, reasoning: "looks normal" }),
    resolveFn: async () => { throw new Error("resolveFn must not be called when not suspicious"); },
  });
  assert("Not suspicious -> no verdict at all (not WARN, not NEEDS_REVIEW, not null-as-PASS)", notSuspicious === null);
}
{
  const cited = await assessPlausibility({
    fieldPath: "activeIngredients[0].amount", judgePrompt: "p", knowledgeKind: "ingredient_monograph", lookupKey: "l",
    judgeFn: async () => ({ suspicious: true, reasoning: "unusually high for this form" }),
    resolveFn: async () => ({ summary: "EMA states typical range is 100-200mg/g", sourceUrls: ["https://www.ema.europa.eu/x"], citations: [{ url: "https://www.ema.europa.eu/x" }] }),
  });
  assert("Suspicious + citable source found -> WARN", cited.status === "WARN", cited);
  assert("plausibilitySource is 'external' when a source was found", cited.plausibilitySource === "external", cited);
  assert("citation/sourceUrl carried through from the resolved knowledge", cited.sourceUrl === "https://www.ema.europa.eu/x", cited);
}
{
  const uncited = await assessPlausibility({
    fieldPath: "withdrawalPeriod", judgePrompt: "p", knowledgeKind: "ingredient_monograph", lookupKey: "l",
    judgeFn: async () => ({ suspicious: true, reasoning: "inconsistent with this ingredient class" }),
    resolveFn: async () => null, // Tier 5 miss — no authoritative citation found
  });
  assert("Suspicious but NO citable source found -> NEEDS_REVIEW (case [ج])", uncited.status === "NEEDS_REVIEW", uncited);
  assert("plausibilitySource is 'model_knowledge' when no source was found", uncited.plausibilitySource === "model_knowledge", uncited);
  assert("Message discloses it's an unsourced observation for human review", uncited.message.toLowerCase().includes("unsourced") || uncited.message.toLowerCase().includes("human review"), uncited);
  assert("withdrawalPeriod (a §8.2 forbidden field) still carries no suggested value", uncited.remediation.suggested === null, uncited);
}

// ── run(): wiring across all four checks, fully faked ───────────────────────
log("\n-- run() end-to-end with fakes --", "cyan");
{
  const labelData = {
    pharmaceuticalForm: { translations: { en: "Oral Powder" }, primary: "en" },
    activeIngredients: [
      { translations: { en: "Amoxicillin" }, primary: "en", amount: "500", unit: "mg/g", normalizedName: "amoxicillin" },
      { translations: { en: "Colistin" }, primary: "en", amount: "50", unit: "mg/g", normalizedName: "colistin" },
    ],
    directionOfUse: { translations: { en: "1g per 10kg bodyweight" }, primary: "en" },
    targetAnimalSpecies: { list: ["Poultry"] },
    withdrawalPeriod: { translations: { en: "7 days" }, primary: "en" },
  };
  const alwaysSuspiciousNoSource = { judgeFn: async () => ({ suspicious: true, reasoning: "flagged" }), resolveFn: async () => null };
  const verdicts = await run(labelData, alwaysSuspiciousNoSource);
  assert(
    "run() returns one verdict per check that had something to flag (concentration x2, dose, compatibility, withdrawal)",
    verdicts.length === 5,
    verdicts.map((v) => v.path)
  );
  assert("Every verdict from run() is WARN or NEEDS_REVIEW, never PASS/FAIL", verdicts.every((v) => v.status === "WARN" || v.status === "NEEDS_REVIEW"), verdicts.map((v) => v.status));
  assert("Every verdict carries layer='plausibility'", verdicts.every((v) => v.layer === "plausibility"));
}
{
  const nothingSuspicious = { judgeFn: async () => ({ suspicious: false, reasoning: "fine" }), resolveFn: async () => null };
  const verdicts = await run({ activeIngredients: [] }, nothingSuspicious);
  assert("run() returns an empty array, not a false PASS, when nothing is flagged", Array.isArray(verdicts) && verdicts.length === 0);
}

log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`, failed === 0 ? "green" : "red");
process.exit(failed > 0 ? 1 : 0);
