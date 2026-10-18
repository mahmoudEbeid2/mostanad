import { BYPASS } from "./testBypass.js";
import fs from "fs";
import path from "path";
import { prisma } from "../src/lib/prisma.js";
import geminiClient from "../src/services/ai/geminiClient.js";
import { MODELS } from "../src/services/ai/modelRegistry.js";
import { verifyProductLabel } from "../src/services/labelService.js";

// Tests never call a paid API. Over HTTP the label worker runs with
// GEMINI_DISABLED=true, so a queued job must fail loudly at the guard. The
// extraction → DB match → validation flow is then driven in-process with a
// fixed extraction injected at the geminiClient seam (test-side only — the
// product code has no mock mode). Any other Gemini call still hits the guard.
process.env.GEMINI_DISABLED = "true";
const FAKE_EXTRACTION = {
  productName: "H-VIRAL",
  productType: "feed_additive",
  activeIngredients: [{ name: "Olive Leaves", concentration: "10%" }, { name: "Sorbitol", concentration: "5%" }],
  targetAnimalSpeciesList: ["Poultry"],
  extractionMeta: { targetAnimalSpeciesList: { confidence: 0.9, ambiguous: false } },
  aimOfUse: "Immune support and stress relief.",
  directionOfUse: "1-2 ml per Litre",
  storage: "Store below 25C",
  netWeight: "1L",
};
const fakeCalls = [];
const realGenerate = geminiClient.generateContentWithRetry.bind(geminiClient);
Object.assign(geminiClient, {
  uploadFile: async (_p, o = {}) => (fakeCalls.push("uploadFile"), { name: "files/fake", uri: "fake://label", mimeType: o.mimeType }),
  getFile: async () => (fakeCalls.push("getFile"), { state: "ACTIVE" }),
  deleteFile: async () => (fakeCalls.push("deleteFile"), {}),
  generateContentWithRetry: async (req, ...rest) => {
    if (req?.model !== MODELS.EXTRACT.id) return realGenerate(req, ...rest);
    fakeCalls.push("extract");
    return { text: JSON.stringify(FAKE_EXTRACTION) };
  },
});

const BASE_URL = "http://127.0.0.1:3000/api/v1";

const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

let passed = 0;
let failed = 0;
let testProductId = null;

const log = (msg, color = "white") =>
  console.log(`${colors[color]}${msg}${colors.reset}`);

const separator = () => log("─".repeat(62), "cyan");

function assert(label, condition, details = "") {
  if (condition) {
    log(`  ✅ PASS: ${label}`, "green");
    passed++;
  } else {
    log(`  ❌ FAIL: ${label}`, "red");
    if (details) log(`     → ${details}`, "yellow");
    failed++;
  }
}

// All requests go to /products/verify-label with bypass header
async function sendLabelRequest(formData) {
  const res = await fetch(`${BASE_URL}/products/verify-label`, {
    method: "POST",
    headers: { "x-test-bypass": BYPASS },
    body: formData,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

async function pollTask(jobId) {
  if (!jobId) return null;
  let task = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const checkRes = await fetch(`${BASE_URL}/background-tasks/${jobId}`, { headers: { "x-test-bypass": BYPASS } });
    task = (await checkRes.json())?.data;
    if (task && (task.status === "completed" || task.status === "failed")) break;
  }
  return task;
}

async function run() {
  log("\n" + "═".repeat(62), "cyan");
  log("  📁 MOSTANAD - AI MEDICINE LABEL VERIFICATION TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  // ─────────────────────────────────────────────────────
  // TEST 1: Missing file
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 1: POST /products/verify-label — Missing File", "bold");
  {
    const form = new FormData();
    form.append("country", "Saudi Arabia");
    const { status, data } = await sendLabelRequest(form);

    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message mentions file", data?.message?.toLowerCase().includes("file"), data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // TEST 2: Missing country
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 2: POST /products/verify-label — Missing Country", "bold");
  {
    const form = new FormData();
    const mockPdf = Buffer.from("%PDF-1.4 mock label");
    form.append("label", new Blob([mockPdf], { type: "application/pdf" }), "mock.pdf");
    const { status, data } = await sendLabelRequest(form);

    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message mentions country", data?.message?.toLowerCase().includes("country"), data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // TEST 3: Full verification — product NOT in DB
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 3: POST /products/verify-label — Compliance Check (Product NOT in DB)", "bold");

  // Resolve label PDF
  let labelPath = "C:/Users/ENG MAHMOUD/Downloads/10 - H-VIRAL_1L.pdf";
  if (!fs.existsSync(labelPath)) {
    const fixturePdf = path.join(process.cwd(), "fixtures", "regulatory", "synthetic-authority-fixture.pdf");
    const fallback1 = "D:/gemini_test/Addvet Feed Catalogue 2025.pdf";
    const fallback2 = "C:/Users/ENG MAHMOUD/Downloads/Addvet Feed Catalogue 2025.pdf";
    if (fs.existsSync(fallback1)) {
      labelPath = fallback1;
    } else if (fs.existsSync(fallback2)) {
      labelPath = fallback2;
    } else if (fs.existsSync(fixturePdf)) {
      labelPath = fixturePdf;
    } else {
      // Write a minimal mock PDF
      labelPath = path.join(process.cwd(), "test_label_mock.pdf");
      fs.writeFileSync(
        labelPath,
        "%PDF-1.4\n1 0 obj\n<</Type /Catalog>>\nendobj\nProduct: H-VIRAL, Active: Olive Leaves 10%, Storage: Below 25C"
      );
    }
  }

  log(`  Using file: ${labelPath}`, "yellow");
  const labelBuffer = fs.readFileSync(labelPath);
  const labelBlob = new Blob([labelBuffer], { type: "application/pdf" });
  const labelName = path.basename(labelPath);

  const form3 = new FormData();
  form3.append("label", labelBlob, labelName);
  form3.append("country", "Saudi Arabia");
  const { status: s3, data: d3Raw } = await sendLabelRequest(form3);
  assert("Status is 202", s3 === 202, `Got ${s3}. Response: ${JSON.stringify(d3Raw)}`);
  const task3 = await pollTask(d3Raw?.data?.jobId);
  assert("Queued job fails loudly at the Gemini guard", task3?.status === "failed" && /GEMINI_DISABLED/.test(task3?.error || ""), `Status: ${task3?.status}, Error: ${task3?.error}`);
  assert("Guarded job has no result", task3?.result == null, JSON.stringify(task3?.result));

  log("   [Test] Running the verify flow in-process with the fixed extraction...", "cyan");
  const d3 = { status: "success", data: await verifyProductLabel(labelBuffer, labelName, "application/pdf", "Saudi Arabia", null) };
  assert("Fake extraction was used (no real Gemini call)", fakeCalls.includes("extract"), fakeCalls.join(","));
  // Phase 2: labelService now routes through labelExtractor (extraction only) +
  // validationEngine (deterministic FieldVerdict[]), not an AI-judged
  // category/issue/location/solution array — see API-CHANGES.md.
  assert("Has extractedDetails.productName", !!d3?.data?.product?.extractedDetails?.productName?.translations?.en, JSON.stringify(d3?.data?.product));
  assert("existsInDb is boolean", typeof d3?.data?.product?.existsInDb === "boolean", "Expected boolean");
  assert("Has validation object", d3?.data?.validation?.verdicts !== undefined, JSON.stringify(d3?.data?.validation));
  assert("Has verdicts array", Array.isArray(d3?.data?.validation?.verdicts), "Not an array");
  assert("passed is boolean", typeof d3?.data?.validation?.passed === "boolean", "Expected boolean");
  assert("engineVersion present", !!d3?.data?.validation?.engineVersion, "Missing engineVersion");
  assert("regulatoryStatus present at top level", !!d3?.data?.regulatoryStatus, JSON.stringify(d3?.data));
  assert("no companyId → no product match → 'none' state", d3?.data?.productMatchStatus?.state === "none", JSON.stringify(d3?.data?.productMatchStatus));
  assert("no product match → zero data_mismatch verdicts", !d3?.data?.validation?.verdicts?.some((v) => v.comparison === "data_mismatch"), "Unexpected data_mismatch with no matched product");

  if (d3?.data?.validation?.verdicts?.length > 0) {
    const v = d3.data.validation.verdicts[0];
    assert("Verdict has 'path'", !!v.path, JSON.stringify(v));
    assert("Verdict has 'status'", !!v.status, JSON.stringify(v));
    assert("Verdict has 'layer'", !!v.layer, JSON.stringify(v));
  }

  const extractedName = d3?.data?.product?.extractedDetails?.productName?.translations?.en || "EXTRACTED_PRODUCT";
  log(`  Extracted Name: ${extractedName}`, "green");
  log(`  Passed: ${d3?.data?.validation?.passed}`, "green");
  log(`  Errors: ${d3?.data?.validation?.errorCount}, Warnings: ${d3?.data?.validation?.warningCount}`, "green");

  // ─────────────────────────────────────────────────────
  // TEST 4: Full verification — product IS in DB
  //   Create the product then re-verify the same label
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 4: POST /products/verify-label — Compliance Check (Product IN DB)", "bold");

  // Need a company to own the product (DB constraint)
  const ts = Date.now();
  const testCompany = await prisma.company.create({
    data: {
      name: `Label Test Co ${ts}`,
      username: `label_co_${ts}`,
      password: "hashed_test_password",
      email: `label_co_${ts}@test.com`,
    },
  });

  testProductId = (
    await prisma.product.create({
      data: {
        name: extractedName,
        companyId: testCompany.id,
        description: "Test product seeded for label verify test",
        activeIngredients: [
          { name: "Olive Leaves", concentration: "10%" },
          { name: "Sorbitol", concentration: "5%" },
        ],
        dosage: "1-2 ml per Litre of drinking water",
      },
    })
  ).id;

  log(`  Created test product in DB: ${testProductId}`, "green");
  log("⏳ Re-sending same label (DB match expected)...", "cyan");

  // §14.5.1: product matching is tenant-scoped — the caller must state which
  // tenant to match against (here passed straight to the service).
  const d4 = { status: "success", data: await verifyProductLabel(labelBuffer, labelName, "application/pdf", "Saudi Arabia", testCompany.id) };
  assert("existsInDb is true", d4?.data?.product?.existsInDb === true, "Expected true");
  assert("isExactMatch in product is true", d4?.data?.product?.isExactMatch === true, "Expected true");
  assert("dbProduct returned", !!d4?.data?.product?.dbProduct, "dbProduct is null");
  assert("dbProduct.id matches", d4?.data?.product?.dbProduct?.id === testProductId, `Got ${d4?.data?.product?.dbProduct?.id}`);
  assert("companyId NOT exposed", d4?.data?.product?.dbProduct?.companyId === undefined, "companyId should be stripped");
  assert("Verdicts array present", Array.isArray(d4?.data?.validation?.verdicts), "Not an array");
  assert("exact name match → 'matched' state", d4?.data?.productMatchStatus?.state === "matched", JSON.stringify(d4?.data?.productMatchStatus));
  assert("'matched' state → no productMatchStatus message", d4?.data?.productMatchStatus?.message === null, JSON.stringify(d4?.data?.productMatchStatus));
  assert("productMatchStatus carries the candidate and score", !!d4?.data?.productMatchStatus?.candidate && typeof d4?.data?.productMatchStatus?.score === "number", JSON.stringify(d4?.data?.productMatchStatus));

  log(`  DB match: "${d4?.data?.product?.dbProduct?.name}"`, "green");
  log(`  Errors: ${d4?.data?.validation?.errorCount}, Warnings: ${d4?.data?.validation?.warningCount}`, "green");

  // ─────────────────────────────────────────────────────
  // CLEAN UP
  // ─────────────────────────────────────────────────────
  separator();
  log("🧹 Cleaning up database records...", "cyan");
  try {
    if (testProductId) await prisma.product.delete({ where: { id: testProductId } });
    await prisma.company.delete({ where: { id: testCompany.id } });

    // Remove temp mock PDF if created
    const mockPath = path.join(process.cwd(), "test_label_mock.pdf");
    if (fs.existsSync(mockPath)) fs.unlinkSync(mockPath);

    log("  ✅ Cleanup completed.", "green");
  } catch (err) {
    log(`  ❌ Cleanup error: ${err.message}`, "red");
  }

  // SUMMARY
  log("\n" + "═".repeat(62), "cyan");
  log(
    `  📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total`,
    failed === 0 ? "green" : "red"
  );
  log("═".repeat(62) + "\n", "cyan");

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  log(`Fatal Error: ${err.message}`, "red");
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
