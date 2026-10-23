// plan.md P8 — an AI failure reaches a user as a sentence, never as Google's raw
// text, our env flags or model ids. The raw text stays in the database and logs.
// Pure: no API, no database.
import { makeAssert, finish } from "./helpers.js";
import { describeAiError, publicAiError, presentError } from "../../src/services/ai/aiErrorMessage.js";
import globalErrorHandler from "../../src/middleware/errorMiddleware.js";
import AppError from "../../src/utils/appError.js";

const { assert, counts } = makeAssert();
const RAW = {
  disabled: "Gemini calls are disabled in this process (GEMINI_DISABLED=true); geminiClient.generateContent(gemini-2.5-flash) sent no request.",
  quota: "Gemini quota exhausted (daily/project limit, not per-minute) for gemini-2.5-flash — retrying will not help until it resets. Quota exceeded",
  busy: "Gemini API call failed for gemini-2.5-pro after 3 attempts (last status 503): The model is overloaded.",
  bad: "AI returned malformed JSON.",
  other: "Gemini API call failed for gemini-2.5-flash (status 400): Request contains an invalid argument.",
};

console.log("\n🧾 Classification");
for (const [k, code] of [["disabled", "AI_DISABLED"], ["quota", "AI_QUOTA"], ["busy", "AI_BUSY"], ["bad", "AI_BAD_ANSWER"], ["other", "AI_FAILED"]]) {
  const d = describeAiError(RAW[k]);
  assert(`${k} → ${code}, a sentence with no internals`, d?.code === code && !/GEMINI|gemini-|generateContent|status \d/.test(d.message) && /by hand|try again/i.test(d.message), d);
}
assert("wrapped by a job code it's still recognised", describeAiError(`EXTRACTION_FAILED: Invoice extraction failed: ${RAW.quota}`)?.code === "AI_QUOTA");
for (const t of ["Template unavailable", "Only 503 rows fit the table", "Invoice not found"]) assert(`not about AI → untouched: "${t}"`, describeAiError(t) === null && publicAiError(t) === t);
assert("publicAiError accepts an Error", publicAiError(new Error(RAW.disabled)) === describeAiError(RAW.disabled).message);

console.log("\n📦 Stored errors in API rows");
let row = presentError({ id: 1, error: `EXTRACTION_FAILED: ${RAW.disabled}` });
assert("AI failure → sentence + errorCode", row.errorCode === "AI_DISABLED" && !/GEMINI|EXTRACTION_FAILED/.test(row.error), row);
row = presentError({ id: 1, error: "UNSUPPORTED_FORMAT: The file isn't a PDF or an image" });
assert("a coded non-AI error loses its internal prefix", row.error === "The file isn't a PDF or an image" && row.errorCode === "UNSUPPORTED_FORMAT", row);
assert("no error → row unchanged", presentError({ id: 1, error: null }).error === null);

console.log("\n🌐 Error middleware (prod and dev)");
for (const env of ["production", "development"]) {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = env;
  let out = null;
  const res = { status(c) { this.c = c; return this; }, json(b) { out = { code: this.c, body: b }; return this; } };
  const quiet = console.error;
  console.error = () => {};
  globalErrorHandler(new AppError(RAW.disabled, 503), { method: "POST", originalUrl: "/x" }, res, () => {});
  console.error = quiet;
  process.env.NODE_ENV = saved;
  assert(`${env}: 503 with code AI_DISABLED and the sentence, no stack or raw text`, out.code === 503 && out.body.code === "AI_DISABLED" && !JSON.stringify(out.body).includes("GEMINI") && !out.body.stack, out.body);
}

await finish(counts);
