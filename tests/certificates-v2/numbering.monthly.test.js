// 27 Nov (owner): a certificate type's sequence restarts every month — a per-company, per-type setting,
// on by default, as ADDVET's October samples print ("COCAF26 0 10 010": October's 10th). A starting
// number a person sets. Needs Postgres.
import { makeAssert, createCompany, cleanupCompany, prisma } from "./helpers.js";
import { allocateDocNumber, setScheme, learnScheme, listSchemes, monthlyPattern, periodOf } from "../../src/services/certificates/generation/docNumbers.js";

const { assert, counts } = makeAssert();
const NOV = new Date(2026, 10, 27);
const DEC = new Date(2026, 11, 2);

const co = await createCompany("numMonthly");
try {
  console.log("A pattern restarts monthly only when it prints the month and the year");
  assert("COCAF{YY}0{MM}{SEQ3} and COAAVVI{MM}{YY}{SEQ3} can", monthlyPattern("COCAF{YY}0{MM}{SEQ3}") && monthlyPattern("COAAVVI{MM}{YY}{SEQ3}"));
  assert("PL{SEQ6}, FSCAVIV{YY}-{SEQ3}, X{MM}{SEQ3} can't (a restart would print a number twice)", !monthlyPattern("PL{SEQ6}") && !monthlyPattern("FSCAVIV{YY}-{SEQ3}") && !monthlyPattern("X{MM}{SEQ3}"));

  console.log("\nA monthly sequence (the default)");
  await setScheme(co.id, "COC", { pattern: "COCAF{YY}0{MM}{SEQ3}", nextNumber: 1 }, null, NOV);
  const a = [await allocateDocNumber(co.id, "COC", NOV), await allocateDocNumber(co.id, "COC", NOV)];
  assert("November: 001, 002", a.join() === "COCAF26011001,COCAF26011002", a);
  const dec = await allocateDocNumber(co.id, "COC", DEC);
  assert("December starts again at 001", dec === "COCAF26012001", dec);
  const dec2 = await allocateDocNumber(co.id, "COC", DEC);
  assert("…then 002", dec2 === "COCAF26012002", dec2);

  console.log("\nThe switch off: the sequence runs on");
  await setScheme(co.id, "COA", { pattern: "COAAVVI{MM}{YY}{SEQ3}", nextNumber: 34, resetMonthly: false }, null, NOV);
  const n = [await allocateDocNumber(co.id, "COA", NOV), await allocateDocNumber(co.id, "COA", DEC)];
  assert("034 in November, 035 in December", n.join() === "COAAVVI1126034,COAAVVI1226035", n);

  console.log("\nA pattern with no month runs on, whatever the switch");
  await setScheme(co.id, "HC", { pattern: "PL{SEQ6}", nextNumber: 231563 }, null, NOV);
  const h = [await allocateDocNumber(co.id, "HC", NOV), await allocateDocNumber(co.id, "HC", DEC)];
  assert("PL231563, PL231564", h.join() === "PL231563,PL231564", h);

  console.log("\nThe starting number a person sets");
  await setScheme(co.id, "COC", { pattern: "COCAF{YY}0{MM}{SEQ3}", nextNumber: 15 }, null, DEC);
  const s = await allocateDocNumber(co.id, "COC", DEC);
  assert("next number 15 → COCAF26012015", s === "COCAF26012015", s);
  await setScheme(co.id, "COC", { pattern: "COCAF{YY}0{MM}{SEQ3}", nextNumber: 2 }, null, DEC);
  const low = await allocateDocNumber(co.id, "COC", DEC);
  assert("…never below a number already given this month (002 and 015 are)", low === "COCAF26012016", low);

  console.log("\nWhat the documents teach, for a monthly pattern");
  await prisma.numberingScheme.deleteMany({ where: { companyId: co.id, certCode: "FSC" } });
  await learnScheme(co.id, "FSC", { pattern: "FSC{YY}{MM}-{SEQ3}", seq: 10, example: "October sample" });
  const l = (await listSchemes(co.id)).find((x) => x.certCode === "FSC");
  assert("October's 010 doesn't carry into this month: the next is 001", l.nextNumber === 1 && l.monthly === true && l.seqPeriod === periodOf(), l);

  const list = await listSchemes(co.id, DEC);
  const coc = list.find((x) => x.certCode === "COC");
  assert("the numbering page reads the switch and the next number", coc.resetMonthly === true && coc.monthly === true && coc.nextNumber === 17 && coc.next === "COCAF26012017", coc);
  assert("a month later the page already shows 001", (await listSchemes(co.id, new Date(2027, 0, 5))).find((x) => x.certCode === "COC").next === "COCAF27001001");
} finally {
  await cleanupCompany(co.id);
}
console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
await prisma.$disconnect();
process.exit(counts.failed ? 1 : 0);
