import fontkit from "@pdf-lib/fontkit";
import { prisma } from "../../../lib/prisma.js";
import * as fileStore from "../storage/fileStore.js";
import { CertError } from "../errors.js";
import { cleanFontName } from "../analysis/fontFallbackMatch.js";

// A company's own fonts for its certificate templates (client report 24 Nov: the
// design fonts Axiforma, Microgramma, MyriadPro were all drawn from Noto Sans).
// A design embeds only the characters it printed; a value character it lacks is
// drawn from the font matched to it. An uploaded font (.ttf/.otf/.woff2) is a
// match like the shipped ones: a version's font entry keeps its name and glyph
// coverage ({ company: { id, name, coverage, weight, style } }), the shipped
// match stays as the next font tried, and only the bytes travel to the renderer
// (rendererClient → companyFontData). An uploaded font is suggested — and set on
// draft versions — for the design fonts of the same family.

export const MAX_FONT_BYTES = 10 * 1024 * 1024;
const FORMATS = [
  { format: "ttf", mimeType: "font/ttf", magic: (b) => b.readUInt32BE(0) === 0x00010000 || b.subarray(0, 4).toString("latin1") === "true" },
  { format: "otf", mimeType: "font/otf", magic: (b) => b.subarray(0, 4).toString("latin1") === "OTTO" },
  { format: "woff2", mimeType: "font/woff2", magic: (b) => b.subarray(0, 4).toString("latin1") === "wOF2" },
];

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The code points a font draws → [[from, to]…], the manifest's coverage shape. */
export function coverageRanges(codePoints) {
  const cps = [...new Set(codePoints)].sort((a, b) => a - b);
  const out = [];
  for (const cp of cps) {
    const last = out[out.length - 1];
    if (last && cp === last[1] + 1) last[1] = cp;
    else out.push([cp, cp]);
  }
  return out;
}

/** The font file → { format, mimeType, family, name, weight, style, coverage } (refuses what isn't a font). */
export function readFont(buffer, originalName = "font") {
  if (!buffer?.length || buffer.length < 12) throw new CertError("INVALID_FONT_FILE", `${originalName} is empty`, 400);
  if (buffer.length > MAX_FONT_BYTES) throw new CertError("INVALID_FONT_FILE", `${originalName} is larger than 10 MB`, 400);
  const kind = FORMATS.find((f) => f.magic(buffer));
  if (!kind) throw new CertError("INVALID_FONT_FILE", `${originalName} isn't a TrueType, OpenType or WOFF2 font`, 400);
  let font;
  try {
    font = fontkit.create(buffer);
  } catch (err) {
    throw new CertError("INVALID_FONT_FILE", `${originalName} can't be read as a font: ${err.message}`, 400);
  }
  const records = font.name?.records || {};
  const pick = (r) => (r ? r.en || Object.values(r)[0] : null);
  const family = pick(records.preferredFamily) || font.familyName || cleanFontName(font.postscriptName) || originalName.replace(/\.[a-z0-9]+$/i, "");
  const name = font.fullName || `${family} ${pick(records.preferredSubfamily) || font.subfamilyName || ""}`.trim();
  const os2 = font["OS/2"] || {};
  const coverage = coverageRanges(font.characterSet || []);
  if (!coverage.length) throw new CertError("INVALID_FONT_FILE", `${originalName} has no characters`, 400);
  return { format: kind.format, mimeType: kind.mimeType, family: String(family).trim(), name: String(name).trim(), weight: os2.usWeightClass || 400, style: Boolean(font.italicAngle) || Boolean(os2.fsSelection?.italic) ? "italic" : "normal", coverage };
}

const view = (f) => ({ id: f.id, family: f.family, name: f.name, weight: f.weight, style: f.style, format: f.format, originalName: f.originalName, createdAt: f.createdAt });

/** What a version's font entry keeps of a company font. */
export const entryFor = (f) => ({ id: f.id, name: f.name, weight: f.weight, style: f.style, coverage: f.coverage });

export async function listCompanyFonts(companyId, { withCoverage = false } = {}) {
  const rows = await prisma.companyFont.findMany({ where: { companyId }, orderBy: [{ family: "asc" }, { weight: "asc" }] });
  return withCoverage ? rows : rows.map(view);
}

/**
 * The company font closest to a design font, or null: the same family (its
 * name inside the design font's PDF name, "Axiforma-Book" ← Axiforma), then
 * the same face name, then the nearest weight and the same style.
 */
export function suggestCompanyFont(fonts, { pdfName, weight = 400, style = "normal" } = {}) {
  const pdf = norm(cleanFontName(pdfName));
  if (!pdf) return null;
  const score = (f) => {
    const fam = norm(f.family);
    if (!fam || !pdf.includes(fam)) return null;
    return (norm(f.name) === pdf ? 1000 : 0) - Math.abs((f.weight || 400) - (weight || 400)) - (f.style === style ? 0 : 300);
  };
  let best = null;
  let bestScore = -Infinity;
  for (const f of fonts) {
    const s = score(f);
    if (s !== null && s > bestScore) {
      best = f;
      bestScore = s;
    }
  }
  return best;
}

/** Each design font of `fontFallbacks` that an uploaded font suits, set to it ("company_auto"); a person's choice is kept. */
export function withCompanySuggestions(fontFallbacks, fonts) {
  if (!fontFallbacks || !fonts.length) return { fontFallbacks, changed: 0 };
  let changed = 0;
  const out = {};
  for (const [fontClass, entry] of Object.entries(fontFallbacks)) {
    if (entry.source === "owner" || entry.company) {
      out[fontClass] = entry;
      continue;
    }
    const f = suggestCompanyFont(fonts, entry);
    if (f) {
      out[fontClass] = { ...entry, company: entryFor(f), source: "company_auto" };
      changed++;
    } else out[fontClass] = entry;
  }
  return { fontFallbacks: out, changed };
}

/**
 * POST /certificate-fonts — one font file for the company. Draft and ready
 * versions (not active ones: an active version doesn't change) whose design
 * fonts are of its family use it at once. → { font, appliedTo: versions changed }
 */
export async function uploadCompanyFont({ companyId, userId = null, file }) {
  const info = readFont(file?.buffer, file?.originalname || "font");
  const stored = await fileStore.putFile({ companyId, kind: "company_font", buffer: file.buffer, mimeType: info.mimeType, originalName: file.originalname || null, ext: info.format });
  const data = { companyId, family: info.family, name: info.name, weight: info.weight, style: info.style, format: info.format, fileId: stored.id, coverage: info.coverage, originalName: file.originalname || null, uploadedByUserId: userId };
  // the same face uploaded again replaces the earlier file
  const font = await prisma.companyFont.upsert({ where: { companyId_family_weight_style: { companyId, family: info.family, weight: info.weight, style: info.style } }, create: data, update: data });
  const appliedTo = await applyToDraftVersions(companyId);
  return { font: view(font), appliedTo };
}

export async function applyToDraftVersions(companyId) {
  const fonts = await listCompanyFonts(companyId, { withCoverage: true });
  const versions = await prisma.templateVersion.findMany({ where: { template: { companyId }, status: { in: ["draft", "ready"] } }, select: { id: true, fontFallbacks: true } });
  let n = 0;
  for (const v of versions) {
    const { fontFallbacks, changed } = withCompanySuggestions(v.fontFallbacks, fonts);
    if (!changed) continue;
    const { count } = await prisma.templateVersion.updateMany({ where: { id: v.id, status: { in: ["draft", "ready"] } }, data: { fontFallbacks } });
    n += count;
  }
  return n;
}

export async function loadCompanyFont(id, companyId) {
  const f = await prisma.companyFont.findUnique({ where: { id } });
  if (!f || (companyId && f.companyId !== companyId)) throw new CertError("NOT_FOUND", "Font not found!", 404);
  return f;
}

const bytesCache = new Map(); // fileId → base64: a stored file never changes (an upload of the same face gets a new file)
/** The bytes the renderer embeds (subset) → { [fontId]: base64 } for the ids that exist. */
export async function fontBytes(ids) {
  const out = {};
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const rows = await prisma.companyFont.findMany({ where: { id: { in: unique } }, select: { id: true, fileId: true, companyId: true } });
  for (const r of rows) {
    if (!bytesCache.has(r.fileId)) {
      const { buffer } = await fileStore.readFile(r.fileId, { companyId: r.companyId });
      if (bytesCache.size >= 64) bytesCache.delete(bytesCache.keys().next().value);
      bytesCache.set(r.fileId, buffer.toString("base64"));
    }
    out[r.id] = bytesCache.get(r.fileId);
  }
  return out;
}

/** The ids of the company fonts a render's fontFallbacks use. */
export const companyFontIds = (fontFallbacks) => Object.values(fontFallbacks || {}).map((e) => e?.company?.id).filter(Boolean);
