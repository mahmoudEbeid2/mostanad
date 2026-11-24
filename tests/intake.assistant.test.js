// Files dropped in the assistant chat go through the same auto-intake: start_intake
// stages them (nothing created), the drop is recognised in the background, and the
// answer carries an "intake" block — the review card the page shows too. The model is
// a script (no Gemini call). Needs `npm run dev:test` (the classify job runs in the worker).
import { PDFDocument, StandardFonts } from "pdf-lib";
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, api, asAdmin, createCompany, cleanupCompany, pollTask } from "./certificates-v2/helpers.js";
import * as assistant from "../src/services/assistant/assistantService.js";
import { runAgent } from "../src/services/assistant/agent/agentLoop.js";
import { storeAttachments } from "../src/services/assistant/attachments.js";
import { SYSTEM_PROMPT } from "../src/services/assistant/agent/systemPrompt.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
// the API's test bypass user, so the drop is readable over HTTP with asAdmin
const admin = { kind: "user", id: "00000000-0000-0000-0000-000000000000", name: "bypass", permissions: null };
const script = (steps) => {
  const seen = [];
  return { seen, generate: async (req) => (seen.push(req), { content: { role: "model", parts: steps[Math.min(seen.length - 1, steps.length - 1)] }, usage: { promptTokenCount: 5, candidatesTokenCount: 1 } }) };
};
async function pdf(title, text) {
  const d = await PDFDocument.create();
  d.setTitle(title);
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([595, 842]).drawText(text, { x: 30, y: 800, size: 8, font: f });
  return Buffer.from(await d.save());
}

async function main() {
  console.log("🧪 Auto-intake from the assistant chat\n");
  const co = await createCompany("intakechat");
  await assistant.updateSettings("system", { enabled: true, messagesPerUserPerHour: 1000, modelCallsPerDay: 100000 });
  try {
    const bypassId = (await api("GET", "/auth/me", asAdmin)).data?.data?.user?.id;
    if (bypassId) admin.id = bypassId;
    const conv = await assistant.createConversation(admin, { companyId: null });
    const files = await storeAttachments({
      conversationId: conv.id,
      companyId: null, // dropped in "All companies"
      actor: admin,
      files: [
        { buffer: await pdf("MAXVET COA", "CERTIFICATE OF ANALYSIS Product Name: VITAMAX 1L Category Batch No.: MXV2601 Results"), originalname: "MAXVET COA.pdf", mimetype: "application/pdf" },
        { buffer: await pdf("MAXVET FSC", "FREE SALE CERTIFICATE Document #: FSCMXV-1 Date: 01/11/2026 www.maxvet.com"), originalname: "MAXVET FSC.pdf", mimetype: "application/pdf" },
      ],
    });
    const m = script([[{ functionCall: { name: "start_intake", args: {} } }], [{ text: "رتبت الملفات تحت — راجع الكارت ودوس «نفّذ الكل»." }]]);
    const out = await runAgent({ text: "دي شهادات maxvet", ctx: { actor: admin, scope: { companyId: null }, conversationId: conv.id, attachments: files, audit: async () => {} }, generate: m.generate });
    const block = out.blocks.find((b) => b.type === "intake");
    assert("'دي شهادات maxvet' + files → start_intake, no company asked, no invoice asked", out.toolCalls[0]?.name === "start_intake" && out.toolCalls[0].ok && !/فاتورة|invoice|ID|معرف/i.test(out.text), out.toolCalls);
    assert("…the answer carries the intake review block", !!block?.batchId, out.blocks);
    const batch = await prisma.intakeBatch.findUnique({ where: { id: block.batchId }, include: { items: true } });
    assert("…a drop with both files, in this conversation, nothing created yet", batch.items.length === 2 && batch.conversationId === conv.id && (await prisma.certificateTemplate.count({ where: { company: { name: { contains: "MAXVET", mode: "insensitive" } } } })) === 0);
    const task = await pollTask(batch.classifyTaskId, asAdmin, { timeoutMs: 60000 });
    const view = (await api("GET", `/intake/batches/${batch.id}`, asAdmin)).data?.data;
    const coa = view?.items.find((i) => i.name === "MAXVET COA.pdf");
    assert("recognised in the background: a filled COA and an FSC, company MAXVET proposed new", task?.status === "completed" && coa?.docType === "certificate_filled" && coa.certCode === "COA" && view.items.find((i) => i.name === "MAXVET FSC.pdf")?.certCode === "FSC" && view.newEntities.companies.some((c) => c.name === "MAXVET"), view?.items?.map((i) => `${i.name}:${i.docType}:${i.company?.name}`));
    assert("…with no MAXVET design file, each issued certificate also becomes its template (one per type)", coa.action === "certificate_both", coa.action);
    assert("the prompt: files → start_intake once; never ask which company or an invoice ID; 'no Addvet yet — drop the files'", /call start_intake ONCE/.test(SYSTEM_PROMPT) && /never ask which company first/.test(SYSTEM_PROMPT) && /there's no Addvet yet/.test(SYSTEM_PROMPT));
  } finally {
    await prisma.intakeBatch.deleteMany({ where: { ownerId: admin.id, conversationId: { not: null } } }).catch(() => {});
    await prisma.assistantConversation.deleteMany({ where: { ownerId: admin.id, title: { contains: "maxvet", mode: "insensitive" } } }).catch(() => {});
    await cleanupCompany(co.id).catch(() => {});
  }
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
