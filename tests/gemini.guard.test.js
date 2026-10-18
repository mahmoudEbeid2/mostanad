// Tests never call a paid API. With GEMINI_DISABLED=true every Gemini entry
// point must fail loudly (503, the guard's message) before any HTTP request
// leaves the process. A global fetch trap proves "no request": both SDKs
// (@google/genai and the deprecated @google/generative-ai) go through fetch.
// No server or DB needed.
process.env.GEMINI_DISABLED = "true";
process.env.MOCK_GEMINI = "false";
if (!process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = "guard-test-placeholder";

const requests = [];
globalThis.fetch = async (url) => {
  requests.push(String(url));
  throw new Error(`fetch trap: ${url}`);
};

const { default: geminiClient } = await import("../src/services/ai/geminiClient.js");
const { assertGeminiEnabled, geminiWorkerName } = await import("../src/services/ai/geminiGuard.js");
const batchClient = await import("../src/services/ai/batchClient.js");
const { processCatalogPDF } = await import("../src/services/catalogService.js");
const { generateCertificatesAndPopulateTemplates } = await import("../src/services/certificateService.js");
const { generateHtmlFromDesign } = await import("../src/services/aiTemplateService.js");
const labelExtractor = await import("../src/services/label/extraction/labelExtractor.js");

let passed = 0;
let failed = 0;
function assert(label, condition, details = "") {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}${details ? `\n     → ${details}` : ""}`);
    failed++;
  }
}

async function blocked(label, fn) {
  const before = requests.length;
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert(
    `${label} → 503 at the guard`,
    err?.statusCode === 503 && /GEMINI_DISABLED=true/.test(err?.message || ""),
    err ? `${err.statusCode} ${err.message}` : "resolved"
  );
  assert(`${label} → no HTTP request`, requests.length === before, requests.slice(before).join(", "));
}

const pdf = Buffer.from("%PDF-1.4\n%%EOF");
const req = { model: "any-model", contents: [{ text: "x" }] };

console.log("\n🧪 Gemini guard (GEMINI_DISABLED=true)");
await blocked("geminiClient.generateContentWithRetry", () => geminiClient.generateContentWithRetry(req));
await blocked("geminiClient.generateJson", () => geminiClient.generateJson({ ...req, schema: {} }));
await blocked("geminiClient.generateText", () => geminiClient.generateText(req));
await blocked("geminiClient.uploadFile", () => geminiClient.uploadFile("x.pdf", { mimeType: "application/pdf" }));
await blocked("geminiClient.getFile", () => geminiClient.getFile("files/x"));
await blocked("geminiClient.deleteFile", () => geminiClient.deleteFile("files/x"));
await blocked("geminiClient.ai (raw SDK access)", () => geminiClient.ai.models);
await blocked("batchClient.createBatch", () => batchClient.createBatch({ model: "m", items: [] }));
await blocked("batchClient.getBatch", () => batchClient.getBatch("batches/x"));
await blocked("batchClient.cancelBatch", () => batchClient.cancelBatch("batches/x"));
await blocked("catalogService.processCatalogPDF", () => processCatalogPDF("00000000-0000-0000-0000-000000000000", pdf));
await blocked("certificateService (V1)", () =>
  generateCertificatesAndPopulateTemplates("00000000-0000-0000-0000-000000000000", null, "shipping", pdf, "i.pdf", "application/pdf")
);
await blocked("aiTemplateService (dead V1 code)", () => generateHtmlFromDesign("x.pdf", "x.pdf", "application/pdf"));
await blocked("labelExtractor.extract", () => labelExtractor.extract(pdf, "l.pdf", "application/pdf", "Saudi Arabia", null));

console.log("\n🧪 Worker names carry the guard state");
assert("disabled → ':gemini-off'", geminiWorkerName("labelQueue") === "labelQueue:gemini-off", geminiWorkerName("labelQueue"));
process.env.GEMINI_DISABLED = "false";
assert("enabled → ':gemini-on'", geminiWorkerName("labelQueue") === "labelQueue:gemini-on", geminiWorkerName("labelQueue"));
let threw = false;
try {
  assertGeminiEnabled("probe");
} catch {
  threw = true;
}
assert("guard off → assertGeminiEnabled passes", !threw);
process.env.GEMINI_DISABLED = "true";

assert("zero HTTP requests in total", requests.length === 0, requests.join(", "));

console.log(`\n📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);
