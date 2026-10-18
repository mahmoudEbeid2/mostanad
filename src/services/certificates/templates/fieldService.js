import crypto from "crypto";
import { prisma } from "../../../lib/prisma.js";
import { CertError } from "../errors.js";
import * as fileStore from "../storage/fileStore.js";
import * as renderer from "../engine/renderer.js";
import { loadVersion } from "./templateService.js";
import { validateSource, validateFormat } from "./sourceCatalogue.js";

// Field definitions on a draft TemplateVersion (CERTIFICATES_V2_PLAN.md §8.2,
// D3, D10). The UI sends the full list; the server validates it against the
// version's analysed lines AND the real layout (renderer `inspect`), stores it
// and returns the server-measured suggestions (align center, D11).

const KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;
const ALIGNS = ["left", "center", "right"];
const ORIGINS = ["manual", "detected", "ai_suggested"];

const fail = (problems) =>
  new CertError("INVALID_FIELDS", `The field list is invalid: ${problems.slice(0, 5).map((p) => `${p.key ? `${p.key}: ` : ""}${p.message}`).join("; ")}`, 422, {
    problems,
  });

/** Stable hash of what prepare depends on — a report for other fields is stale. */
export function fieldsHash(fields) {
  const canon = fields
    .map((f) => [f.key, f.lineId, f.charStart, f.charEnd, f.sampleValue, f.align || "left"])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return crypto.createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
}

/**
 * Pure validation (§8.2) against the version's analysed lines.
 * → { fields (normalised), problems: [{ key, message }] }
 */
export function validateFieldList(input, lines) {
  const problems = [];
  const byLine = new Map((lines || []).map((l) => [l.id, l]));
  const keys = new Set();
  const fields = (input || []).map((raw, i) => {
    const f = {
      key: String(raw.key || "").trim(),
      label: String(raw.label || "").trim(),
      lineId: raw.lineId,
      charStart: raw.charStart,
      charEnd: raw.charEnd,
      sampleValue: raw.sampleValue,
      source: raw.source,
      format: raw.format ?? null,
      required: raw.required !== false,
      align: raw.align || "left",
      origin: raw.origin || "manual",
      confirmed: raw.confirmed,
      sortOrder: Number.isInteger(raw.sortOrder) ? raw.sortOrder : i,
    };
    const p = (message) => problems.push({ key: f.key || `#${i + 1}`, message });
    if (!KEY_RE.test(f.key)) p("key must be snake_case (a-z, 0-9, _), starting with a letter");
    else if (keys.has(f.key)) p("key is used twice");
    keys.add(f.key);
    if (!f.label) p("label is required");
    if (!ALIGNS.includes(f.align)) p(`align must be one of ${ALIGNS.join(", ")}`);
    if (!ORIGINS.includes(f.origin)) p(`origin must be one of ${ORIGINS.join(", ")}`);
    // D10: a field marked by hand is confirmed by definition; detected / AI
    // suggested fields stay unconfirmed until the user confirms them
    f.confirmed = f.origin === "manual" ? true : f.confirmed === true;
    const line = byLine.get(f.lineId);
    if (!line) p(`line "${f.lineId}" does not exist in this version`);
    else {
      f.page = line.page || 1;
      if (!Number.isInteger(f.charStart) || !Number.isInteger(f.charEnd) || f.charStart < 0 || f.charEnd > line.text.length || f.charStart >= f.charEnd) {
        p(`offsets ${f.charStart}–${f.charEnd} are outside the line (length ${line.text.length})`);
      } else if (line.text.slice(f.charStart, f.charEnd) !== f.sampleValue) {
        p(`the text at ${f.charStart}–${f.charEnd} is "${line.text.slice(f.charStart, f.charEnd)}", not "${f.sampleValue}"`);
      } else if (!f.sampleValue.trim() || f.sampleValue !== f.sampleValue.trim()) {
        p("the selected value must not be blank or start/end with a space");
      }
    }
    for (const m of validateSource(f.source)) p(m);
    for (const m of validateFormat(f.format, f.source)) p(m);
    return f;
  });
  // no overlapping ranges on the same line
  const sorted = fields.filter((f) => Number.isInteger(f.charStart)).sort((a, b) => (a.lineId === b.lineId ? a.charStart - b.charStart : a.lineId < b.lineId ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (a.lineId === b.lineId && b.charStart < a.charEnd) problems.push({ key: b.key, message: `overlaps "${a.key}" on line ${a.lineId}` });
  }
  return { fields, problems };
}

const publicField = (f) => {
  const { versionId, ...rest } = f;
  return rest;
};

export async function listFields(versionId) {
  const rows = await prisma.templateField.findMany({ where: { versionId }, orderBy: [{ sortOrder: "asc" }, { key: "asc" }] });
  return rows.map(publicField);
}

/** Measures fields in the sanitized document (no mutation). → { [key]: inspect result } */
async function inspectInLayout(version, fields) {
  if (!fields.length) return {};
  const html = await fileStore.readText(version.sanitizedFileId);
  return renderer.withDocument(
    html,
    (page) => renderer.engine(page, "inspect", fields.map((f) => ({ key: f.key, lineId: f.lineId, charStart: f.charStart, charEnd: f.charEnd, sampleValue: f.sampleValue }))),
    { label: "fields:inspect" }
  );
}

/**
 * PUT /template-versions/:id/fields — replaces the full list (idempotent).
 * Draft only. → { fields, suggestions: { [key]: { align } }, fieldsHash }
 */
export async function replaceFields(versionId, companyId, input) {
  const version = await loadVersion(versionId, companyId);
  if (version.status !== "draft") {
    throw new CertError("VERSION_NOT_DRAFT", `Fields can only be changed on a draft version (this one is ${version.status}). Create a new version to change them.`, 409);
  }
  const { fields, problems } = validateFieldList(input, version.lines);
  if (problems.length) throw fail(problems);

  // the analysed text must also hold in the real layout (same browser as prepare)
  const measured = await inspectInLayout(version, fields);
  const layoutProblems = fields.filter((f) => !measured[f.key]?.ok).map((f) => ({ key: f.key, message: `not found in the document (${measured[f.key]?.error || "unknown"})` }));
  if (layoutProblems.length) throw fail(layoutProblems);

  await prisma.$transaction([
    prisma.templateField.deleteMany({ where: { versionId } }),
    prisma.templateField.createMany({
      data: fields.map((f) => ({
        versionId,
        key: f.key,
        label: f.label,
        page: f.page,
        lineId: f.lineId,
        origin: f.origin,
        confirmed: f.confirmed,
        charStart: f.charStart,
        charEnd: f.charEnd,
        sampleValue: f.sampleValue,
        source: f.source,
        format: f.format ?? undefined,
        required: f.required,
        align: f.align,
        sortOrder: f.sortOrder,
      })),
    }),
  ]);

  const suggestions = Object.fromEntries(
    fields.filter((f) => measured[f.key]?.suggestedAlign && measured[f.key].suggestedAlign !== f.align).map((f) => [f.key, { align: measured[f.key].suggestedAlign }])
  );
  return { fields: await listFields(versionId), suggestions, fieldsHash: fieldsHash(fields), boxes: Object.fromEntries(fields.map((f) => [f.key, measured[f.key].box])) };
}

/** Marks fields confirmed (D10) — the only change allowed to a field outside a full PUT. */
export async function confirmFields(versionId, companyId, keys) {
  const version = await loadVersion(versionId, companyId);
  if (!["draft", "ready"].includes(version.status)) throw new CertError("VERSION_NOT_EDITABLE", `This version is ${version.status}`, 409);
  await prisma.templateField.updateMany({ where: { versionId, key: { in: keys } }, data: { confirmed: true } });
  return listFields(versionId);
}
