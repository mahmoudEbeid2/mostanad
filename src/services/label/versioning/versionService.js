import { prisma } from "../../../lib/prisma.js";
import AppError from "../../../utils/appError.js";

/**
 * Creates a GeneratedLabel row plus its version 1 in a single transaction.
 * This is the only place a GeneratedLabel is ever inserted.
 */
export const createInitial = async ({
  companyId,
  productId = null,
  createdByUserId = null,
  inputPayload,
  productProfile = null,
  labelData,
  labelProvenance,
  schemaVersion,
  country,
  language,
  status = "draft",
  referenceLabelIds = [],
  regulatoryDocIds = [],
  matchTier = null,
  generationMeta = null,
  changeSummary = "Initial AI generation",
}) => {
  return prisma.$transaction(async (tx) => {
    const label = await tx.generatedLabel.create({
      data: {
        companyId,
        productId,
        createdByUserId,
        inputPayload,
        productProfile,
        labelData,
        labelProvenance,
        schemaVersion,
        country,
        language,
        status,
        referenceLabelIds,
        regulatoryDocIds,
        matchTier,
        generationMeta,
        currentVersion: 1,
      },
    });

    await tx.labelVersion.create({
      data: {
        labelId: label.id,
        versionNumber: 1,
        labelData,
        changeSource: "ai_generation",
        changeSummary,
      },
    });

    return label;
  });
};

/**
 * Appends a new version onto an existing label and updates the label's
 * current labelData/currentVersion to match. Never mutates a prior version.
 *
 * meta: { changeSource, changedByUserId?, changeSummary?, diff?, restoredFrom?,
 *         overrideAcknowledged?, validationReportId? }
 */
export const createVersion = async (labelId, labelData, meta = {}) => {
  const {
    changeSource,
    changedByUserId = null,
    changeSummary = null,
    diff: diffPayload = null,
    restoredFrom = null,
    overrideAcknowledged = false,
    validationReportId = null,
  } = meta;

  if (!changeSource) {
    throw new AppError("createVersion requires meta.changeSource", 500);
  }

  return prisma.$transaction(async (tx) => {
    const label = await tx.generatedLabel.findUnique({ where: { id: labelId } });
    if (!label) throw new AppError("Label not found", 404);

    const versionNumber = label.currentVersion + 1;

    const version = await tx.labelVersion.create({
      data: {
        labelId,
        versionNumber,
        labelData,
        changeSource,
        changedByUserId,
        changeSummary,
        diff: diffPayload,
        restoredFrom,
        overrideAcknowledged,
        validationReportId,
      },
    });

    await tx.generatedLabel.update({
      where: { id: labelId },
      data: { labelData, currentVersion: versionNumber },
    });

    return version;
  });
};

/**
 * Structural diff between two labelData snapshots. Returns a flat list of
 * { path, op, before, after } — op is "add" | "remove" | "replace", matching
 * the shape LabelVersion.diff is stored as (§5.2).
 */
export const diff = (a, b) => {
  const changes = [];

  const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  const walk = (path, before, after) => {
    if (before === after) return;

    const beforeIsObj = isPlainObject(before);
    const afterIsObj = isPlainObject(after);
    const beforeIsArr = Array.isArray(before);
    const afterIsArr = Array.isArray(after);

    if (beforeIsObj && afterIsObj) {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of keys) {
        walk(path ? `${path}.${key}` : key, before[key], after[key]);
      }
      return;
    }

    if (beforeIsArr && afterIsArr) {
      const maxLen = Math.max(before.length, after.length);
      for (let i = 0; i < maxLen; i++) {
        walk(`${path}[${i}]`, before[i], after[i]);
      }
      return;
    }

    if (JSON.stringify(before) === JSON.stringify(after)) return;

    if (before === undefined) {
      changes.push({ path, op: "add", before: null, after });
    } else if (after === undefined) {
      changes.push({ path, op: "remove", before, after: null });
    } else {
      changes.push({ path, op: "replace", before, after });
    }
  };

  walk("", a, b);
  return changes;
};

/**
 * Restore is forward-only: restoring version K appends a new version N+1
 * with K's content. History is append-only — nothing is ever deleted or
 * rewritten (CLAUDE.md invariant on versioning, §13).
 */
export const restore = async (labelId, versionNumber) => {
  const target = await prisma.labelVersion.findUnique({
    where: { labelId_versionNumber: { labelId, versionNumber } },
  });
  if (!target) throw new AppError(`Version ${versionNumber} not found for this label`, 404);

  return createVersion(labelId, target.labelData, {
    changeSource: "restore",
    restoredFrom: versionNumber,
    changeSummary: `Restored from version ${versionNumber}`,
  });
};
