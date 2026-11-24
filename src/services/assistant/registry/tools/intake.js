import { z } from "zod";
import { defineTool } from "../registry.js";
import { ToolError } from "../access.js";
import { prisma } from "../../../../lib/prisma.js";
import { createBatch, startClassify } from "../../../intake/intakeService.js";

// Files dropped in the chat → the same auto-intake as "ارفع ملفاتك": each file is
// recognised (what it is, whose), and one review card shows them all under the
// answer. Starting it creates nothing in the system — only the staging rows; the
// person files everything with "نفّذ الكل" on that card.
defineTool({
  name: "start_intake",
  module: "files",
  core: true,
  risk: "read",
  permissions: ["read_products"],
  label: "Sorting the files",
  description:
    "Sorts files the user attached — any kind and any number (labels, certificates, invoices, catalogues, designs, product lists) — WITHOUT asking which company first: each file is recognised " +
    "(what it is, which company / brand / products), missing companies, brands and products are proposed, and ONE review card under your answer shows every file and what will happen. " +
    "Use it whenever the user sends files and says what they are in general (\"دي شهادات maxvet\", \"ارفع ملفات addvet\", \"خد الملفات دي\") or sends several files. " +
    "attachmentIds: the files (omit = every file attached in this conversation). After calling it, say in one short sentence that the card shows each file and the button files them all.",
  args: z.object({ attachmentIds: z.array(z.string().uuid()).min(1).max(100).optional() }),
  run: async (a, ctx) => {
    if (!ctx.conversationId) throw new ToolError("No conversation", "no_conversation");
    const atts = await prisma.assistantAttachment.findMany({ where: { conversationId: ctx.conversationId, ...(a.attachmentIds ? { id: { in: a.attachmentIds } } : {}) }, orderBy: { createdAt: "asc" } });
    if (!atts.length) throw new ToolError("This conversation has no attached files. Tell the user to attach them with the paperclip (files sent on WhatsApp or by email are not here).", "no_files");
    if (a.attachmentIds && atts.length !== new Set(a.attachmentIds).size) throw new ToolError("Some of those files aren't in this conversation", "not_found");
    const actor = ctx.actor.kind === "company" ? { kind: "company", id: ctx.actor.id, companyId: ctx.actor.companyId } : { kind: "user", id: ctx.actor.id };
    const batch = await createBatch(actor, { companyId: ctx.companyId || null, conversationId: ctx.conversationId });
    for (const att of atts) {
      const file = await prisma.storedFile.findUnique({ where: { id: att.fileId }, select: { sha256: true } });
      await prisma.intakeItem.create({ data: { batchId: batch.id, name: att.name, sizeBytes: att.sizeBytes, receivedBytes: att.sizeBytes, fileId: att.fileId, sha256: file?.sha256 || null, mimeType: att.mimeType, status: "uploaded" } });
    }
    await startClassify(actor, batch.id);
    return { intakeBatchId: batch.id, files: atts.length, note: "The files are being sorted. The card under your answer lists each one: what it is, its company / brand / products and what will happen. Nothing is created until the user presses نفّذ الكل on it." };
  },
});
