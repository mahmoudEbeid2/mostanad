import { PDFDocument } from "pdf-lib";
import { prisma } from "../../lib/prisma.js";
import AppError from "../../utils/appError.js";
import * as fileStore from "../certificates/storage/fileStore.js";

// Files in the assistant chat (C2). Stored like every other upload — fileStore,
// in the conversation's company, never "All companies" — and referenced by id in
// tool args. The model never receives the bytes: a tool that already reads that
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

export const attachmentView = (a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, sizeBytes: a.sizeBytes, pages: a.pages ?? null, createdAt: a.createdAt });

/**
 * Stores files for a conversation whose company is `companyId` (already checked
 * by the caller: the conversation's owner, a real company). → [attachment]
 */
export async function storeAttachments({ conversationId, companyId, actor, files }) {
  if (!companyId) throw new AppError("Pick a company before attaching a file — files belong to one company, not \"All companies\".", 400);
  if (!files?.length) throw new AppError("Choose at least one file", 400);
  if (files.length > MAX_ATTACHMENTS) throw new AppError(`At most ${MAX_ATTACHMENTS} files at a time`, 400);
  const checked = files.map((f) => ({ file: f, kind: detectKind(f.buffer, f.originalname || "file") }));
  const out = [];
  for (const { file, kind } of checked) {
    const name = String(file.originalname || `file.${kind.ext}`).slice(0, 200);
    const stored = await fileStore.putFile({ companyId, kind: "assistant_attachment", buffer: file.buffer, mimeType: kind.mimeType, originalName: name, ext: kind.ext });
    out.push(
      await prisma.assistantAttachment.create({
        data: { conversationId, companyId, ownerType: actor.kind, ownerId: actor.id, fileId: stored.id, name, mimeType: kind.mimeType, sizeBytes: file.buffer.length, pages: kind.ext === "pdf" ? await pageCount(file.buffer) : null },
      })
    );
  }
  return out.map(attachmentView);
}

/**
 * One attachment of this conversation in this company — anything else is "not found"
 * (another tenant's file, another conversation's, or a company mismatch).
 */
export async function loadAttachment(id, { conversationId, companyId }) {
  const a = typeof id === "string" ? await prisma.assistantAttachment.findUnique({ where: { id } }).catch(() => null) : null;
  if (!a || a.conversationId !== conversationId || (companyId && a.companyId !== companyId)) throw new AppError("Attachment not found!", 404);
  return a;
}

/** The bytes, for the tool that reads this kind of file. → { buffer, originalname, mimetype } (multer's shape) */
export async function attachmentFile(a) {
  const { buffer } = await fileStore.readFile(a.fileId, { companyId: a.companyId });
  return { buffer, originalname: a.name, mimetype: a.mimeType, size: buffer.length };
}
