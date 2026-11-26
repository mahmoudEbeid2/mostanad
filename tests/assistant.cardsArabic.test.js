// 26 Nov (Phase 6): an Arabic chat showed "Make a certificate for a product (no invoice)", "Certificate
// Type Id" and "batchNo, productionDate, expiryDate not given…". Every card keeps its English and gets
// Arabic beside it; the page shows the person's language. Pure (no server).
import { withArabic, missingAr } from "../src/services/assistant/cardArabic.js";
import { makeAssert } from "./certificates-v2/helpers.js";

const { assert, counts } = makeAssert();
const p = withArabic("generate_certificate_for_product", {
  title: "Make a certificate for a product (no invoice)",
  runLabel: "Make the certificate",
  fields: [{ name: "certificateTypeId", label: "Certificate Type Id" }, { name: "productId", label: "Product" }],
  details: [{ label: "Batch No", value: "LOT-1" }, { label: "Some new row", value: "x" }],
  missing: ["batchNo, productionDate, expiryDate not given — empty and flagged on the draft"],
});
assert("title, button: Arabic beside the English", p.titleAr === "شهادة لمنتج (من غير فاتورة)" && p.title.startsWith("Make") && p.runLabelAr === "اعمل الشهادة");
assert("«Certificate Type Id» → «نوع الشهادة», «Product» → «المنتج»", p.fields[0].labelAr === "نوع الشهادة" && p.fields[1].labelAr === "المنتج");
assert("a detail label: Arabic when known, else none (the English shows)", p.details[0].labelAr === "رقم التشغيلة" && p.details[1].labelAr === null);
assert("the missing batch facts in Arabic — and that nothing is filled in", /رقم التشغيلة، تاريخ الإنتاج، تاريخ الانتهاء/.test(p.missingAr[0]) && /مش هنملاها/.test(p.missingAr[0]));
assert("an unknown missing line stays as it is", missingAr("something else") === null);
assert("a tool without an Arabic title keeps its English (no blank)", withArabic("some_tool", { title: "X" }).titleAr === null);
console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
process.exit(counts.failed ? 1 : 0);
