// Certificates V2 Phase 0 / plan D7 — catalog upload has no mock fallback.
// Drives processCatalogPDF directly (no API server needed). A Gemini failure
// must reject with the real error and write nothing; before Phase 0 it
// silently "succeeded" with a hardcoded H-VIRAL product. No paid API: the
// failure is produced by GEMINI_DISABLED, and a fetch trap proves no request
// leaves the process.
import { prisma } from "../src/lib/prisma.js";
import { processCatalogPDF } from "../src/services/catalogService.js";

process.env.GEMINI_DISABLED = "true";
const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  if (/googleapis\.com/.test(String(url))) {
    requests.push(String(url));
    throw new Error(`fetch trap: ${url}`);
  }
  return realFetch(url, ...rest);
};

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

const ts = Date.now();
const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<</Type /Catalog>>\nendobj\n%%EOF");
const realKey = process.env.GEMINI_API_KEY;
let companyId = null;

async function attempt() {
  try {
    await processCatalogPDF(companyId, pdf, "catalog.pdf");
    return null;
  } catch (err) {
    return err;
  }
}

async function run() {
  console.log("\n🧪 Catalog upload — no mock fallback");
  const company = await prisma.company.create({
    data: { name: `NoMock ${ts}`, username: `nomock_${ts}`, password: "x", email: `nomock_${ts}@example.com` },
  });
  companyId = company.id;

  // MOCK_GEMINI must no longer change behaviour.
  process.env.MOCK_GEMINI = "true";

  // 1. No key → explicit configuration error.
  delete process.env.GEMINI_API_KEY;
  let err = await attempt();
  assert("missing key → rejects", !!err, "resolved instead of rejecting");
  assert("missing key → 500", err?.statusCode === 500, `${err?.statusCode}`);
  assert("missing key → says the key is not configured", /not configured/i.test(err?.message || ""), err?.message);
  assert("MOCK_GEMINI=true does not produce mock data", (await prisma.product.count({ where: { companyId } })) === 0);

  // 2. Key present but Gemini unavailable → that real error surfaces; no
  //    fallback product is written.
  process.env.GEMINI_API_KEY = "placeholder-key-never-sent";
  err = await attempt();
  assert("Gemini unavailable → rejects", !!err, "resolved instead of rejecting");
  assert("Gemini unavailable → 503", err?.statusCode === 503, `${err?.statusCode}`);
  assert(
    "Gemini unavailable → carries the real error, not a mock",
    /GEMINI_DISABLED=true/.test(err?.message || "") && !/mock/i.test(err?.message || ""),
    err?.message
  );

  const products = await prisma.product.findMany({ where: { companyId } });
  assert("Gemini unavailable → zero products written", products.length === 0, `${products.length} products`);
  assert("no hardcoded H-VIRAL product", !products.some((p) => p.name === "H-VIRAL"));
  assert("no request reached Google", requests.length === 0, requests.join(", "));
}

run()
  .catch((e) => {
    console.error("Fatal:", e);
    failed++;
  })
  .finally(async () => {
    if (realKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = realKey;
    if (companyId) {
      await prisma.product.deleteMany({ where: { companyId } });
      await prisma.company.delete({ where: { id: companyId } });
    }
    await prisma.$disconnect();
    console.log(`\n📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total\n`);
    process.exit(failed > 0 ? 1 : 0);
  });
