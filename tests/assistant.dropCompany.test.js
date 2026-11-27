// Acceptance #7 / #8 (27 Nov): after a drop in "All companies" whose files went to ADDVET, the one-line
// answer was met with "which company?". A chat whose latest drop went to ONE company works in it; a
// message with new files doesn't (they may be another company's). Needs Postgres. The model is a script.
import { makeAssert, createCompany, cleanupCompany, prisma } from "./certificates-v2/helpers.js";
import * as assistant from "../src/services/assistant/assistantService.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const admin = { kind: "user", id: "00000000-0000-4000-8000-000000000271", name: "drop company", permissions: null, can: () => true };
const scripted = () => {
  const seen = [];
  return { seen, generate: async (req) => (seen.push(JSON.parse(JSON.stringify(req))), { content: { role: "model", parts: [{ text: "تمام." }] }, usage: {} }) };
};
const coA = await createCompany("dropCoA");
const coB = await createCompany("dropCoB");
await assistant.updateSettings("system", { enabled: true, messagesPerUserPerHour: 1000, modelCallsPerDay: 100000 });
try {
  const conv = await assistant.createConversation(admin, { companyId: null });
  const m0 = scripted();
  await assistant.sendMessage(admin, conv.id, { text: "مرحبا", companyId: "all" }, { generate: m0.generate });
  assert("no drop yet: the chat stays in All companies", JSON.stringify(m0.seen[0].contents).includes("current company: All companies"));

  const batch = await prisma.intakeBatch.create({ data: { ownerType: "user", ownerId: admin.id, conversationId: conv.id, companyId: null, mode: "express", status: "done" } });
  await prisma.intakeItem.create({ data: { batchId: batch.id, name: "COA.pdf", sizeBytes: 1, receivedBytes: 1, status: "done", companyId: coA.id } });
  const m1 = scripted();
  const turn = await assistant.sendMessage(admin, conv.id, { text: "ADDHEPA حجم 240 KG — pH 5.2", companyId: "all" }, { generate: m1.generate });
  assert("after a drop filed in one company, the answer works in it", turn.message?.companyId === coA.id && JSON.stringify(m1.seen[0].contents).includes(`(id ${coA.id})`), { companyId: turn.message?.companyId });

  await prisma.intakeItem.create({ data: { batchId: batch.id, name: "other.pdf", sizeBytes: 1, receivedBytes: 1, status: "done", companyId: coB.id } });
  const m2 = scripted();
  const two = await assistant.sendMessage(admin, conv.id, { text: "كمّل", companyId: "all" }, { generate: m2.generate });
  assert("a drop spread over two companies: no company is guessed", two.message?.companyId === null, { companyId: two.message?.companyId });
} finally {
  await cleanupCompany(coA.id).catch(() => {});
  await cleanupCompany(coB.id).catch(() => {});
}
console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
await prisma.$disconnect();
process.exit(counts.failed ? 1 : 0);
