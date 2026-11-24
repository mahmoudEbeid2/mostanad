// Client report 24 Nov, item 6: "Ask Assistant to fix" on "Could not check — No
// approved regulatory rules exist yet" did nothing ("دي مش بتروح خالص"). The label
// chat can only edit label fields; when the model proposes no change, the chat
// now answers why (status no_change) instead of saving an empty version, and
// the refused / no-change outcomes come back as answers the chat shows.
// Model calls are scripted at the geminiClient seam (no paid API).
import { prisma } from "../src/lib/prisma.js";
import geminiClient from "../src/services/ai/geminiClient.js";
import * as generatedLabelService from "../src/services/label/generatedLabelService.js";
import { run as runRules } from "../src/services/label/validation/ruleValidator.js";
import { makeAssert, createCompany, cleanupCompany } from "./certificates-v2/helpers.js";
import { SAMPLE_LABEL_DATA } from "./fixtures/labelLayoutSample.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();

const replies = [];
geminiClient.generateJson = async () => replies.shift();

async function main() {
  console.log("🧪 Label chat — a request it can't act on is answered\n");
  const co = await createCompany("lchat");
  try {
    const noRules = runRules(SAMPLE_LABEL_DATA, []);
    assert("no rules for the country → one 'could not check' verdict keyed NO_AUTHORITATIVE_REQUIREMENTS (what the page turns into the Regulatory & EDA link)", noRules.length === 1 && noRules[0].status === "UNVERIFIABLE" && noRules[0].ruleKey === "NO_AUTHORITATIVE_REQUIREMENTS" && noRules[0].path === "_regulatory");

    const label = await prisma.generatedLabel.create({ data: { companyId: co.id, inputPayload: {}, labelData: SAMPLE_LABEL_DATA, labelProvenance: {}, schemaVersion: "vet-label@2.0.0", country: "ZZ", language: "en", status: "draft" } });
    const before = label.currentVersion;
    replies.push({ intent: "edit" }, { changes: [], rationale: "Regulatory rules are not part of the label." });
    const out = await generatedLabelService.chat(label.id, { message: "Fix the label: No approved regulatory rules exist yet for this country/product scope.", expectedVersion: before, companyId: co.id });
    assert("an edit with nothing to change → status no_change with an answer", out.status === "no_change" && /didn't change the label/.test(out.answer) && /Regulatory & EDA/.test(out.answer), out);
    const after = await prisma.generatedLabel.findUnique({ where: { id: label.id } });
    assert("…no new version was saved", after.currentVersion === before, { before, after: after.currentVersion });
    const history = await generatedLabelService.getChatHistory(label.id, { companyId: co.id });
    assert("…and the chat history holds the question and the answer", history.length >= 2 && history.at(-1).role === "assistant" && /didn't change the label/.test(history.at(-1).content), history.map((m) => m.role));
  } finally {
    await prisma.labelChatMessage.deleteMany({ where: { label: { companyId: co.id } } }).catch(() => {});
    await cleanupCompany(co.id).catch((e) => console.error(e.message));
  }
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
