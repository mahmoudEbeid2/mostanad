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
    "attachmentIds: the files (omit = every file attached in this conversation). After calling it, say in one short sentence that the card shows each file and the button files them all. " +
    "express: true when the user wants CERTIFICATES made from these files NOW (\"طلّعلي الشهادات دي\", \"طلّعلي شهادات COA وFSC للمنتجات دي\", urgent order) — after the same one click, the certificate files become templates, " +
    "and certificate DRAFTS are made for every product in the files (no registration first, no invoice); everything made is marked \"Express — needs review\". certificateTypes: the types they asked for (e.g. [\"COA\",\"FSC\"]), omit = every type in the files. " +
    "Never fill batch numbers, dates or lab results: missing ones stay marked blanks on the drafts. " +
    "newCompanyName: when the user chose or said the files are for a NEW company (\"(شركة جديدة: ADDVET)\") — the drop then creates that company, even if another company has a brand of that name.",
  args: z.object({
    attachmentIds: z.array(z.string().uuid()).min(1).max(100).optional(),
    express: z.boolean().optional(),
    certificateTypes: z.array(z.string().trim().min(2).max(8)).max(10).optional(),
    newCompanyName: z.string().trim().min(2).max(120).optional(),
  }),
  run: async (a, ctx) => {
    if (!ctx.conversationId) throw new ToolError("No conversation", "no_conversation");
    const atts = await prisma.assistantAttachment.findMany({ where: { conversationId: ctx.conversationId, ...(a.attachmentIds ? { id: { in: a.attachmentIds } } : {}) }, orderBy: { createdAt: "asc" } });
    if (!atts.length) throw new ToolError("This conversation has no attached files. Tell the user to attach them with the paperclip (files sent on WhatsApp or by email are not here).", "no_files");
    if (a.attachmentIds && atts.length !== new Set(a.attachmentIds).size) throw new ToolError("Some of those files aren't in this conversation", "not_found");
    const actor = ctx.actor.kind === "company" ? { kind: "company", id: ctx.actor.id, companyId: ctx.actor.companyId } : { kind: "user", id: ctx.actor.id };
    // the chat's «شركة جديدة: X» chip writes the person's choice into their message: read it by code too
    const chosen = a.newCompanyName || [...(ctx.userTexts || [])].reverse().map((t) => String(t || "").match(/\(\s*شركة جديدة\s*:\s*([^)\n]{2,120})\)/)?.[1]?.trim()).find(Boolean) || null;
    const batch = await createBatch(actor, { companyId: ctx.companyId || null, conversationId: ctx.conversationId, express: a.express ? { certificateTypes: a.certificateTypes || [] } : null, newCompanyName: chosen });
    for (const att of atts) {
      const file = await prisma.storedFile.findUnique({ where: { id: att.fileId }, select: { sha256: true } });
      await prisma.intakeItem.create({ data: { batchId: batch.id, name: att.name, sizeBytes: att.sizeBytes, receivedBytes: att.sizeBytes, fileId: att.fileId, sha256: file?.sha256 || null, mimeType: att.mimeType, status: "uploaded" } });
    }
    await startClassify(actor, batch.id);
    if (a.express) return { intakeBatchId: batch.id, files: atts.length, express: true, note: "The files are being sorted. The card under your answer says what will be created (company, brand, products, templates) and asks only what it must; ONE button files everything and then makes the certificate drafts, shown on the same card with their PDFs. Nothing is created until the user presses it. Drafts are marked Express — needs review." };
    return { intakeBatchId: batch.id, files: atts.length, note: "The files are being sorted. The card under your answer lists each one: what it is, its company / brand / products and what will happen. Nothing is created until the user presses نفّذ الكل on it." };
  },
});

// 26 Nov: "استخدم الشهادات اللي بعتها كقوالب (COA و COC و HC) وطلّع منها شهادات للعشر منتجات" → the
// answer claimed twice that it had done it (blocked), then "لم أُجهّز أي عملية…". This is that
// operation: the certificate files already dropped in THIS conversation become their types'
// templates (one per type; the type is created when missing) and certificate drafts are made
// for the drop's products — the same Express run as the card's "طلّع الشهادات". One card.
const latestDrop = (ctx, batchId) =>
  prisma.intakeBatch.findFirst({ where: { conversationId: ctx.conversationId, ...(batchId ? { id: batchId } : {}), ownerType: ctx.actor.kind === "company" ? "company" : "user", ownerId: ctx.actor.id }, orderBy: { createdAt: "desc" }, include: { items: true } });

async function dropPlan(a, ctx) {
  if (!ctx.conversationId) throw new ToolError("No conversation", "no_conversation");
  const batch = await latestDrop(ctx, a.batchId);
  if (!batch) throw new ToolError("No files were dropped in this conversation yet — attach the certificates (and labels) and send them first.", "no_files");
  if (batch.companyId && ctx.companyId && batch.companyId !== ctx.companyId) throw new ToolError("Those files belong to another company", "not_found");
  const { certificateFilesWithoutTemplate } = await import("../../../intake/expressService.js");
  const certs = batch.items.filter((i) => !i.parentId && ["certificate_filled", "certificate_template"].includes(i.classification?.docType) && i.classification?.certCode);
  const toMake = batch.status === "done" ? certificateFilesWithoutTemplate(batch.items) : certs;
  const asked = (a.certificateTypes || []).map((c) => c.toUpperCase());
  const files = toMake.filter((i) => !asked.length || asked.includes(i.classification.certCode));
  const products = new Set(batch.items.flatMap((i) => [...(i.result?.plan?.productIds || []), ...(i.classification?.proposal?.products || []).map((p) => p.id || p.name)]));
  return { batch, files, asked, products: products.size };
}

defineTool({
  name: "use_files_as_templates",
  module: "certificates", // offered whenever a message is about certificates / templates (قوالب، شهادات)
  risk: "write",
  permissions: ["create_certificate_templates", "create_certificates"],
  label: "Making templates from your certificates",
  description:
    "Use when the user says to use the certificates they ALREADY SENT in this conversation as templates (\"استخدم الشهادات اللي بعتها كقوالب\", \"use the files I sent as templates\", \"اعمل منها قوالب وطلّع الشهادات\"). " +
    "One card: each certificate file of the conversation's latest drop becomes its type's template (one per type, the type created when missing), then certificate DRAFTS are made for the drop's products " +
    "(batch numbers, dates and lab results stay marked blanks). certificateTypes: the types they named (e.g. [\"COA\",\"COC\",\"HC\"]), omit = every certificate file. No new upload, no invoice.",
  args: z.object({ batchId: z.string().uuid().optional(), certificateTypes: z.array(z.string().trim().min(2).max(8)).max(10).optional() }),
  preview: async (a, ctx) => {
    const { batch, files, asked, products } = await dropPlan(a, ctx);
    if (!files.length) throw new ToolError(`The files in this conversation have no ${asked.length ? asked.join(", ") + " " : ""}certificate that isn't a template already`, "nothing_to_do");
    return {
      title: `Make ${files.length} template${files.length === 1 ? "" : "s"} from your certificates, then the certificates`,
      summary: `Each certificate you sent becomes its type's template; then draft certificates are made for ${products || "the"} product${products === 1 ? "" : "s"} of the files. Batch numbers, dates and lab results stay marked blanks for you to fill. Everything is marked Express — needs review.`,
      runLabel: "Make templates and certificates",
      details: [...files.map((i) => ({ label: i.name, value: `${i.classification.certCode} template` })), { label: "Products", value: String(products || "—") }, { label: "Files", value: batch.status === "done" ? "already filed" : "filed with this click" }],
      aiCalls: null,
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const { batch, files, asked } = await dropPlan(a, ctx);
    const intake = await import("../../../intake/intakeService.js");
    const { makeTemplatesFromFiles } = await import("../../../intake/expressService.js");
    const actor = ctx.actor.kind === "company" ? { kind: "company", id: ctx.actor.id, companyId: ctx.actor.companyId, can: () => true } : { kind: "user", id: ctx.actor.id, can: () => true };
    const express = { ...(batch.express || {}), requestedTypes: asked.length ? asked : [...new Set(files.map((i) => i.classification.certCode))] };
    await prisma.intakeBatch.update({ where: { id: batch.id }, data: { mode: "express", express, ...(batch.companyId || !ctx.companyId ? {} : { companyId: ctx.companyId }) } });
    if (batch.status === "review") {
      // not filed yet: the one click files it; each certificate file is also its template (certificate_both)
      await intake.startExecute(actor, batch.id, { revisions: Object.fromEntries(batch.items.filter((i) => i.classification?.proposal).map((i) => [i.id, i.revision])) });
      return { intakeBatchId: batch.id, filing: true, link: null };
    }
    const out = await makeTemplatesFromFiles(batch.id, { userId: ctx.actor.kind === "user" ? ctx.actor.id : null });
    return { intakeBatchId: batch.id, templates: out.made, restarted: out.restarted, link: out.made[0] ? `/certificates/templates/${out.made[0].templateId}/versions/${out.made[0].versionId}` : null };
  },
});

// 28 Nov: the model never saw what the files say — only "a COC of ADDVET". This is what every file
// of the conversation's drops prints (the AI read: value, file, page, the printed words; a value the
// verification doubted says so), or — with no AI read — the company's harvested facts. Read-only.
defineTool({
  name: "read_dropped_files",
  module: "files",
  core: true,
  risk: "read",
  permissions: ["read_products"],
  label: "Reading the files",
  description:
    "What the files dropped in THIS conversation say, value by value, each with its file, page and the printed words: company details, product data (composition, packs, validity, storage, " +
    "dosage, specifications…), batch facts (only from manufacturing orders / lab reports / certificates), document numbering, invoice lines. Use it to answer any question about the files' content " +
    "(\"إيه تركيبة AMINOVITA في الشهادة؟\", \"الفاتورة فيها كام منتج؟\") — never answer from memory. product / field narrow it (field: e.g. ingredient, validity, batchNo, specification). " +
    "A value marked needsReview was doubted by the check: say so. reading: true = the files are still being read; say it and how far it got.",
  args: z.object({
    product: z.string().trim().min(1).max(120).optional(),
    field: z.string().trim().min(1).max(60).optional(),
    batchId: z.string().uuid().optional(),
  }),
  run: async (a, ctx) => {
    if (!ctx.conversationId) throw new ToolError("No conversation", "no_conversation");
    const drops = await prisma.intakeBatch.findMany({ where: { conversationId: ctx.conversationId, ...(a.batchId ? { id: a.batchId } : {}), ownerType: ctx.actor.kind === "company" ? "company" : "user", ownerId: ctx.actor.id }, orderBy: { createdAt: "desc" }, take: 5 });
    if (!drops.length) throw new ToolError("No files were dropped in this conversation yet.", "no_files");
    const want = (v) => (!a.product || String(v.product || "").toLowerCase().includes(a.product.toLowerCase())) && (!a.field || [v.field, v.test].some((x) => String(x || "").toLowerCase() === a.field.toLowerCase()));
    const out = [];
    for (const d of drops) {
      const h = d.harvest || {};
      const label = new Map((h.files || []).map((f) => [f.label, f.name]));
      if (h.status === "done" || (h.values || []).length) {
        const values = (h.values || []).filter(want).slice(0, 300).map((v) => ({ entity: v.entity, field: v.field, test: v.test || undefined, product: v.product || undefined, pack: v.pack || undefined, batchNo: v.batchNo || undefined, value: v.value, amount: v.amount || undefined, file: label.get(v.file) || v.file, page: v.page, quote: v.snippet, needsReview: v.reviewStatus !== "confirmed" ? v.verifyNote || true : undefined }));
        out.push({ dropId: d.id, reader: "ai", files: (h.files || []).map((f) => ({ name: f.name, status: f.status, error: f.error || undefined })), values, more: (h.values || []).filter(want).length > values.length || undefined });
        continue;
      }
      if (["queued", "running"].includes(h.status)) out.push({ dropId: d.id, reading: true, done: h.done ?? 0, total: h.total ?? null });
      // no AI read: what the rules reader stored for the drop's files
      const fileIds = (await prisma.intakeItem.findMany({ where: { batchId: d.id, fileId: { not: null } }, select: { fileId: true } })).map((i) => i.fileId);
      const facts = fileIds.length ? await prisma.harvestedFact.findMany({ where: { fileId: { in: fileIds } }, take: 600, orderBy: { createdAt: "asc" } }) : [];
      const values = facts.map((f) => ({ entity: f.entity, field: f.key, product: f.productName || undefined, value: typeof f.value === "string" ? f.value : JSON.stringify(f.value), file: f.fileName, page: f.page, quote: f.snippet, needsReview: f.reviewStatus !== "confirmed" || undefined })).filter((v) => want({ ...v, field: v.field })).slice(0, 300);
      out.push({ dropId: d.id, reader: h.status === "off" ? "rules" : "rules (AI read not finished)", values });
    }
    return { drops: out };
  },
});
