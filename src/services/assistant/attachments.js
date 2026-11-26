import { PDFDocument } from "pdf-lib";
import { prisma } from "../../lib/prisma.js";
import AppError from "../../utils/appError.js";
import * as fileStore from "../certificates/storage/fileStore.js";

// Files in the assistant chat (C2). Stored like every other upload — fileStore —
// and referenced by id in tool args. A file attached while "All companies" is
// picked is kept in the conversation unbound (companyId null) until the person
// says which company it is for (bindAttachments); no tool reads an unbound file. The model never receives the bytes: a tool that already reads that
// kind of file (the invoice extractor, the COA reader, the catalogue reader…)
// does, once the person approves the action.

export const MAX_ATTACHMENT_BYTES = 60 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const KINDS = [
  { ext: "pdf", mimeType: "application/pdf", magic: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { ext: "png", mimeType: "image/png", magic: (b) => b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG" },
  { ext: "jpg", mimeType: "image/jpeg", magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "webp", mimeType: "image/webp", magic: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** The file's real type from its bytes (the browser's mime type is not trusted). */
export function detectKind(buffer, name = "file") {
  if (!buffer?.length) throw new AppError(`${name}: the file is empty`, 400);
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new AppError(`${name}: files are limited to 60 MB`, 413);
  const kind = KINDS.find((k) => k.magic(buffer));
  if (!kind) throw new AppError(`${name}: attach a PDF, PNG, JPEG or WebP file`, 400);
  return kind;
}

async function pageCount(buffer) {
  try {
    return (await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
  } catch {
    return null; // unreadable structure: the tool that reads it will say why
  }
}

export const attachmentView = (a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, sizeBytes: a.sizeBytes, pages: a.pages ?? null, companyId: a.companyId ?? null, createdAt: a.createdAt });

/**
 * Stores files for a conversation whose company is `companyId` (already checked
 * by the caller: the conversation's owner, a real company) — or null ("All
 * companies"): kept unbound until bindAttachments. → [attachment]
 */
export async function storeAttachments({ conversationId, companyId = null, actor, files }) {
  if (!files?.length) throw new AppError("Choose at least one file", 400);
  if (files.length > MAX_ATTACHMENTS) throw new AppError(`At most ${MAX_ATTACHMENTS} files at a time`, 400);
  const checked = files.map((f) => ({ file: f, kind: detectKind(f.buffer, f.originalname || "file") }));
  const out = [];
  for (const { file, kind } of checked) {
    const name = String(file.originalname || `file.${kind.ext}`).slice(0, 200);
    const stored = await fileStore.putFile({ companyId, kind: "assistant_attachment", buffer: file.buffer, mimeType: kind.mimeType, originalName: name, ext: kind.ext });
    // Harvest (28 Nov): a file sent in a company's chat is read for what it says (in the background)
    if (companyId && kind.ext === "pdf") import("../harvest/harvestService.js").then(({ harvestSoon, kindOf }) => harvestSoon({ companyId, fileId: stored.id, fileName: name, kind: kindOf({ name, certCode: /\b(COA|COC|HC|FSC|COO)\b/i.exec(name)?.[1]?.toUpperCase() || null }), certCode: /\b(COA|COC|HC|FSC|COO)\b/i.exec(name)?.[1]?.toUpperCase() || null })).catch(() => {});
    out.push(
      await prisma.assistantAttachment.create({
        data: { conversationId, companyId, ownerType: actor.kind, ownerId: actor.id, fileId: stored.id, name, mimeType: kind.mimeType, sizeBytes: file.buffer.length, pages: kind.ext === "pdf" ? await pageCount(file.buffer) : null },
      })
    );
  }
  return out.map(attachmentView);
}

/**
 * Binds unbound files of this conversation to `companyId` (the person picked the
 * company after attaching in "All companies"). Files already in that company are
 * left as they are; a file in another company is refused. → [attachment]
 */
export async function bindAttachments(conversationId, ids, companyId) {
  if (!companyId) throw new AppError("Pick a company for the files", 400);
  const rows = await prisma.assistantAttachment.findMany({ where: { id: { in: ids }, conversationId } });
  if (rows.length !== new Set(ids).size) throw new AppError("Attachment not found!", 404);
  if (rows.some((a) => a.companyId && a.companyId !== companyId)) throw new AppError("These files belong to another company than the one picked — attach them again.", 400);
  const unbound = rows.filter((a) => !a.companyId);
  for (const a of unbound) {
    await prisma.$transaction([
      prisma.storedFile.update({ where: { id: a.fileId }, data: { companyId } }),
      prisma.assistantAttachment.update({ where: { id: a.id }, data: { companyId } }),
    ]);
  }
  return (await prisma.assistantAttachment.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: "asc" } })).map(attachmentView);
}

/**
 * One attachment of this conversation, looked up by conversation + id; its
 * company is the file's own. `companyId` (the call's company, when there is one)
 * must match it. A missing file says which files this conversation does have —
 * the model sometimes names a file the person only sent elsewhere (WhatsApp).
 */
export async function loadAttachment(id, { conversationId, companyId }) {
  const a = typeof id === "string" && conversationId ? await prisma.assistantAttachment.findFirst({ where: { id, conversationId } }).catch(() => null) : null;
  if (!a) {
    const here = conversationId ? await prisma.assistantAttachment.findMany({ where: { conversationId }, select: { id: true, name: true }, orderBy: { createdAt: "asc" }, take: 20 }) : [];
    throw new AppError(
      here.length
        ? `No file with that id in this conversation. Its files: ${here.map((f) => `${f.name} (${f.id})`).join(", ")}.`
        : "This conversation has no attached files. Tell the user no file reached the system — a file sent on WhatsApp or by email is not here — and ask them to attach it with the paperclip.",
      404
    );
  }
  if (!a.companyId) throw new AppError(`${a.name} isn't linked to a company yet (it was attached in "All companies"). Ask the user which company it is for.`, 409);
  if (companyId && a.companyId !== companyId) throw new AppError(`${a.name} belongs to another company than the one this is for.`, 404);
  return a;
}

/** The bytes, for the tool that reads this kind of file. → { buffer, originalname, mimetype } (multer's shape) */
export async function attachmentFile(a) {
  const { buffer } = await fileStore.readFile(a.fileId, { companyId: a.companyId });
  return { buffer, originalname: a.name, mimetype: a.mimeType, size: buffer.length };
}
