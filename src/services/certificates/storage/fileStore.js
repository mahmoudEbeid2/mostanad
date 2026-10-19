import fs from "fs";
import path from "path";
import crypto from "crypto";
import { prisma } from "../../../lib/prisma.js";
import { notFound } from "../errors.js";

// Every certificate artifact lives under uploads/certificates/{companyId}/{uuid}.{ext}.
// File names are always server-generated UUIDs — an uploaded file's original
// name is stored as metadata only and never reaches a path or a shell (§14).
const UPLOADS_ROOT = path.resolve(process.cwd(), "uploads");
const CERT_ROOT = path.join(UPLOADS_ROOT, "certificates");

const EXT_BY_MIME = {
  "text/html": "html",
  "application/pdf": "pdf",
  "application/postscript": "ai",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/zip": "zip",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function resolveInside(relPath) {
  const abs = path.resolve(UPLOADS_ROOT, relPath);
  if (!abs.startsWith(CERT_ROOT + path.sep)) {
    throw new Error(`Refusing a stored-file path outside uploads/certificates: ${relPath}`);
  }
  return abs;
}

export function absolutePath(row) {
  return resolveInside(row.path);
}

/**
 * Every regular file under uploads/certificates/{dir}/ (one level, as putFile
 * writes them) → [{ relPath, abs, mtime, size }]; `dirs` narrows to some
 * company directories. For the maintenance sweep (review #14).
 */
export function listDiskFiles(dirs = null) {
  if (!fs.existsSync(CERT_ROOT)) return [];
  const names = dirs || fs.readdirSync(CERT_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const out = [];
  for (const dir of names) {
    const absDir = path.join(CERT_ROOT, dir);
    if (!fs.existsSync(absDir)) continue;
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const relPath = path.posix.join("certificates", dir, ent.name);
      const abs = resolveInside(relPath);
      const st = fs.statSync(abs);
      out.push({ relPath, abs, mtime: st.mtime, size: st.size });
    }
  }
  return out;
}

/** Writes the buffer and creates its StoredFile row. */
export async function putFile({ companyId = null, kind, buffer, mimeType, originalName = null, ext, tx = prisma }) {
  if (companyId !== null && !UUID_RE.test(companyId)) throw new Error(`Invalid companyId for storage: ${companyId}`);
  const extension = ext || EXT_BY_MIME[mimeType] || "bin";
  const relPath = path.posix.join("certificates", companyId || "_system", `${crypto.randomUUID()}.${extension}`);
  const abs = resolveInside(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return tx.storedFile.create({
    data: {
      companyId,
      kind,
      path: relPath,
      mimeType,
      sizeBytes: buffer.length,
      sha256: sha256(buffer),
      originalName,
    },
  });
}

/**
 * Loads a StoredFile row. With `companyId`, a file owned by another tenant is
 * reported as missing (404), never as forbidden.
 */
export async function getFileRow(id, { companyId } = {}) {
  if (!id) throw notFound("File");
  const row = await prisma.storedFile.findUnique({ where: { id } });
  if (!row || (companyId && row.companyId !== companyId)) throw notFound("File");
  return row;
}

export async function readFile(id, opts = {}) {
  const row = await getFileRow(id, opts);
  return { row, buffer: fs.readFileSync(absolutePath(row)) };
}

export async function readText(id, opts = {}) {
  const { buffer } = await readFile(id, opts);
  return buffer.toString("utf8");
}

export function createReadStream(row) {
  return fs.createReadStream(absolutePath(row));
}

/** Removes the file on disk and its row. Missing files on disk are not an error. */
export async function deleteFile(id) {
  const row = await prisma.storedFile.findUnique({ where: { id } });
  if (!row) return false;
  try {
    fs.unlinkSync(absolutePath(row));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  await prisma.storedFile.delete({ where: { id } });
  return true;
}
