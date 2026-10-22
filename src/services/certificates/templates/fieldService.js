import crypto from "crypto";
import { prisma } from "../../../lib/prisma.js";
import { CertError } from "../errors.js";
import * as fileStore from "../storage/fileStore.js";
import * as renderer from "../engine/rendererClient.js";
import { loadVersion } from "./templateService.js";
import { validateSource, validateFormat, validateGroupSource, validateCellSource, GROUP_MODES, WHEN_EMPTY } from "./sourceCatalogue.js";
import { inspectDef } from "./prepareEngine.js";

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

/** Stable hash of what prepare depends on — a report for other fields/groups is stale. */
export function fieldsHash(fields, groups = []) {
  const canon = fields
    .map((f) => [f.key, f.lineId, f.charStart, f.charEnd, f.sampleValue, f.align || "left", f.groupKey || null])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  // only what changes the prepared document or its gate (not labels / sources)
  const g = groups
    .map((x) => [x.key, x.mode || "repeat", x.sampleRows ?? null, x.footerY ?? null, x.minPitchRatio ?? 0.85])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const payload = g.length ? { fields: canon, groups: g } : canon; // unchanged hash for versions without groups
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

export const MAX_GROUP_ROWS = 200;

/**
 * Pure validation of the group list (§7.8, §8.2). `fields` are the validated fields.
 * → { groups (normalised), problems }
 */
export function validateGroupList(input, fields) {
  const problems = [];
  const keys = new Set();
  const fieldKeys = new Set(fields.map((f) => f.key));
  const groups = (input || []).map((raw, i) => {
    const g = {
      key: String(raw.key || "").trim(),
      label: String(raw.label || "").trim(),
      mode: raw.mode || "repeat",
      source: raw.source,
      whenEmpty: raw.whenEmpty || "dash",
      required: raw.required !== false,
      sampleRows: raw.sampleRows === undefined || raw.sampleRows === null ? null : raw.sampleRows,
      footerY: raw.footerY === undefined || raw.footerY === null ? null : raw.footerY,
      minPitchRatio: raw.minPitchRatio === undefined || raw.minPitchRatio === null ? 0.85 : raw.minPitchRatio,
      sortOrder: Number.isInteger(raw.sortOrder) ? raw.sortOrder : i,
    };
    const p = (message) => problems.push({ key: g.key || `group #${i + 1}`, message });
    if (!KEY_RE.test(g.key)) p("group key must be snake_case (a-z, 0-9, _), starting with a letter");
    else if (keys.has(g.key)) p("group key is used twice");
    else if (fieldKeys.has(g.key)) p("group key is also a field key");
    keys.add(g.key);
    if (!g.label) p("label is required");
    if (!GROUP_MODES.includes(g.mode)) p(`mode must be one of ${GROUP_MODES.join(", ")}`);
    if (!WHEN_EMPTY.includes(g.whenEmpty)) p(`whenEmpty must be one of ${WHEN_EMPTY.join(", ")}`);
    if (g.sampleRows !== null && !(Number.isInteger(g.sampleRows) && g.sampleRows >= 1 && g.sampleRows <= 50)) p("sampleRows must be 1–50");
    if (g.footerY !== null && !(typeof g.footerY === "number" && Number.isFinite(g.footerY) && g.footerY > 0)) p("footerY must be a positive number (CSS px from the page top) or null");
    if (!(typeof g.minPitchRatio === "number" && g.minPitchRatio >= 0.85 && g.minPitchRatio <= 1)) p("minPitchRatio must be 0.85–1 (rows never shrink below 85 %)");
    for (const m of validateGroupSource(g.source)) p(m);
    const cells = fields.filter((f) => f.groupKey === g.key);
    if (!cells.length) p("mark the cells of one sample row (fields with this groupKey)");
    return g;
  });
  for (const f of fields.filter((x) => x.groupKey)) {
    const g = groups.find((x) => x.key === f.groupKey);
    if (!g) problems.push({ key: f.key, message: `group "${f.groupKey}" is not defined` });
  }
  const pages = new Map();
  for (const g of groups) {
    const cellPages = new Set(fields.filter((f) => f.groupKey === g.key).map((f) => f.page || 1));
    if (cellPages.size > 1) problems.push({ key: g.key, message: "all cells of a group must be on one page" });
    for (const pg of cellPages) {
      if (pages.has(pg)) problems.push({ key: g.key, message: `page ${pg} already has the group "${pages.get(pg)}" — one repeating group per page` });
      else pages.set(pg, g.key);
    }
  }
  return { groups, problems };
}

/**
 * Pure validation (§8.2) against the version's analysed lines. `groups` (raw)
 * decide how group cells' sources are validated.
 * → { fields (normalised), problems: [{ key, message }] }
 */
export function validateFieldList(input, lines, groups = []) {
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
      groupKey: raw.groupKey ? String(raw.groupKey) : null,
    };
    const p = (message) => problems.push({ key: f.key || `#${i + 1}`, message });
    if (!KEY_RE.test(f.key)) p("key must be snake_case (a-z, 0-9, _), starting with a letter");
    else if (keys.has(f.key)) p("key is used twice");
    keys.add(f.key);
    if (!f.label) p("label is required");
    if (!ALIGNS.includes(f.align)) p(`align must be one of ${ALIGNS.join(", ")}`);
    if (!ORIGINS.includes(f.origin)) p(`origin must be one of ${ORIGINS.join(", ")}`);
    // D10: a field marked by hand is confirmed by definition; detected / AI
    // suggested fields stay unconfirmed until POST …/fields/confirm — the
    // client's `confirmed` is never trusted (review #10; replaceFields keeps
    // what confirm already stored)
    f.confirmed = f.origin === "manual";
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
    if (f.groupKey) {
      // a group cell: its source reads its own row (§10.3)
      const group = (groups || []).find((g) => g?.key === f.groupKey);
      for (const m of validateCellSource(f.source, group?.source)) p(m);
      for (const m of validateFormat(f.format, f.source, group?.source ?? null)) p(m);
    } else {
      for (const m of validateSource(f.source)) p(m);
      for (const m of validateFormat(f.format, f.source)) p(m);
    }
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

export async function listGroups(versionId) {
  const rows = await prisma.templateGroup.findMany({ where: { versionId }, orderBy: [{ sortOrder: "asc" }, { key: "asc" }] });
  return rows.map(publicField);
}

/** Measures fields (and detects groups) in the sanitized document (no mutation). */
async function inspectInLayout(version, fields, groups = []) {
  if (!fields.length) return { fields: {}, groups: {} };
  const html = await fileStore.readText(version.sanitizedFileId);
  return renderer.inspect(html, {
    fields: fields.map((f) => ({ key: f.key, lineId: f.lineId, charStart: f.charStart, charEnd: f.charEnd, sampleValue: f.sampleValue })),
    inspectDefs: groups.map((g) => inspectDef(g, fields)),
  });
}

// What the UI needs from detection: the footer line it proposes, how many rows fit, or why it failed.
const groupView = (d) =>
  d?.ok
    ? { ok: true, shape: d.shape, sampleRowCount: d.sampleRowCount, sampleRows: d.sampleRows, pitch: d.pitch, band: d.band, frame: d.frame, footerY: d.footerY, footerProposal: d.footerProposal, capacity: d.capacity, page: d.page }
    : { ok: false, error: d?.error || "NOT_DETECTED", message: d?.message || null };

/**
 * PUT /template-versions/:id/fields — replaces the full list (idempotent).
 * `groupsInput` (§7.8): omitted = the stored groups are kept; [] removes them.
 * Draft only. → { fields, groups, groupDetection, suggestions: { [key]: { align } }, fieldsHash }
 */
export async function replaceFields(versionId, companyId, input, groupsInput = undefined) {
  const version = await loadVersion(versionId, companyId);
  if (version.status !== "draft") {
    throw new CertError("VERSION_NOT_DRAFT", `Fields can only be changed on a draft version (this one is ${version.status}). Create a new version to change them.`, 409);
  }
  const rawGroups = groupsInput === undefined ? await listGroups(versionId) : groupsInput || [];
  const { fields, problems } = validateFieldList(input, version.lines, rawGroups);
  const { groups, problems: groupProblems } = validateGroupList(rawGroups, fields);
  problems.push(...groupProblems);
  // a group's list must exist for this template's certificates (§10.3)
  for (const g of groups) {
    if (g.source?.kind === "invoice_lines" && version.template.scope !== "per_invoice") problems.push({ key: g.key, message: "invoice lines can only fill a group on a per-invoice (collective) template" });
    if (g.source?.kind === "product_list" && version.template.scope !== "per_product") problems.push({ key: g.key, message: "a product's list can only fill a group on a per-product template — a collective certificate has no single product" });
  }
  if (problems.length) throw fail(problems);
  if (groups.length && version.backgroundFormat !== "svg") {
    throw new CertError(
      "GROUP_NEEDS_SVG",
      "Repeating groups need a version converted with a vector background. Create one with POST /template-versions/:id/enable-groups and mark the group there.",
      409
    );
  }
  // review #10: a stored suggested/detected field can't become "manual" (and so
  // confirmed) by re-sending it; its confirmation is the one /fields/confirm stored
  const stored = new Map((await prisma.templateField.findMany({ where: { versionId }, select: { key: true, origin: true, confirmed: true } })).map((s) => [s.key, s]));
  for (const f of fields) {
    const s = stored.get(f.key);
    if (s && s.origin !== "manual") {
      f.origin = s.origin;
      f.confirmed = s.confirmed === true;
    }
  }

  // the analysed text must also hold in the real layout (same browser as prepare)
  const inspected = await inspectInLayout(version, fields, groups);
  const measured = inspected.fields;
  const layoutProblems = fields.filter((f) => !measured[f.key]?.ok).map((f) => ({ key: f.key, message: `not found in the document (${measured[f.key]?.error || "unknown"})` }));
  if (layoutProblems.length) throw fail(layoutProblems);
  // detection failure (§7.8): refuse the group with a clear message — fixed rows are the designer's fallback
  const undetected = groups.filter((g) => !inspected.groups[g.key]?.ok);
  if (undetected.length) {
    const d = inspected.groups[undetected[0].key] || {};
    throw new CertError(d.error || "GROUP_NOT_DETECTED", `${undetected[0].key}: ${d.message || "the group could not be found in the design"}`, 422, {
      problems: undetected.map((g) => ({ key: g.key, code: inspected.groups[g.key]?.error || "GROUP_NOT_DETECTED", message: inspected.groups[g.key]?.message || null })),
      fallback: "fixed_rows",
    });
  }

  await prisma.$transaction([
    prisma.templateGroup.deleteMany({ where: { versionId } }),
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
        groupKey: f.groupKey,
      })),
    }),
    prisma.templateGroup.createMany({
      data: groups.map((g) => ({
        versionId,
        key: g.key,
        label: g.label,
        mode: g.mode,
        source: g.source,
        whenEmpty: g.whenEmpty,
        required: g.required,
        sampleRows: g.sampleRows,
        footerY: g.footerY,
        minPitchRatio: g.minPitchRatio,
        sortOrder: g.sortOrder,
      })),
    }),
  ]);

  const suggestions = Object.fromEntries(
    fields.filter((f) => measured[f.key]?.suggestedAlign && measured[f.key].suggestedAlign !== f.align).map((f) => [f.key, { align: measured[f.key].suggestedAlign }])
  );
  return {
    fields: await listFields(versionId),
    groups: await listGroups(versionId),
    groupDetection: Object.fromEntries(groups.map((g) => [g.key, groupView(inspected.groups[g.key])])),
    suggestions,
    fieldsHash: fieldsHash(fields, groups),
    boxes: Object.fromEntries(fields.map((f) => [f.key, measured[f.key].box])),
  };
}

/** Marks fields confirmed (D10) — the only change allowed to a field outside a full PUT. */
export async function confirmFields(versionId, companyId, keys) {
  const version = await loadVersion(versionId, companyId);
  if (!["draft", "ready"].includes(version.status)) throw new CertError("VERSION_NOT_EDITABLE", `This version is ${version.status}`, 409);
  await prisma.templateField.updateMany({ where: { versionId, key: { in: keys } }, data: { confirmed: true } });
  return listFields(versionId);
}
