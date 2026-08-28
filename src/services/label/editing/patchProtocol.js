import { labelSchema } from "../schema/labelSchema.js";

const LABEL_SCHEMA_TOP_LEVEL_PATHS = new Set(Object.keys(labelSchema.shape));
const VALID_OPS = ["replace", "append", "remove", "insert"];

// §11.4's guard #1: every path must resolve inside labelSchema. Same
// top-segment check ruleCompiler.isValidTargetPath uses — full nested Zod
// shape validation is more than a patch path allowlist needs; what matters is
// catching a typo'd or nonexistent field, not exhaustively type-checking depth.
export function isValidPatchPath(path) {
  const topSegment = path.split(/[.[]/)[0];
  return LABEL_SCHEMA_TOP_LEVEL_PATHS.has(topSegment);
}

/**
 * Validates a proposed patch's SHAPE (§11.3/§11.4) before anything is applied.
 * Returns { ok: true } or { ok: false, errors: [...] }. Pure.
 */
export function validatePatchShape(patch) {
  const errors = [];
  if (!patch || !Array.isArray(patch.changes) || patch.changes.length === 0) {
    return { ok: false, errors: ["Patch must have a non-empty changes[] array."] };
  }
  for (const change of patch.changes) {
    if (!change.path) errors.push(`Change missing "path": ${JSON.stringify(change)}`);
    else if (!isValidPatchPath(change.path)) errors.push(`Unknown path "${change.path}" — not a field in labelSchema. Rejected, not silently ignored.`);
    if (!VALID_OPS.includes(change.op)) errors.push(`Unsupported op "${change.op}" for path "${change.path}" — must be one of ${VALID_OPS.join(", ")}.`);
    if (change.op !== "remove" && change.value === undefined) errors.push(`Change on "${change.path}" (op: ${change.op}) requires a "value".`);
  }

  // Guard #2: no bulk replacement — a patch touching > 60% of TOP-LEVEL fields
  // is rejected and should become an explicit, approved re-generation instead.
  const touchedTopFields = new Set(patch.changes.map((c) => (c.path || "").split(/[.[]/)[0]));
  const bulkThreshold = 0.6 * LABEL_SCHEMA_TOP_LEVEL_PATHS.size;
  if (touchedTopFields.size > bulkThreshold) {
    errors.push(`Patch touches ${touchedTopFields.size}/${LABEL_SCHEMA_TOP_LEVEL_PATHS.size} top-level fields (> 60%) — this is a bulk replacement, not an edit. Use explicit re-generation instead.`);
  }

  return { ok: errors.length === 0, errors };
}

// Resolves "a.b[2].c" into ["a", "b", 2, "c"] for generic get/set below.
function parsePath(path) {
  return path.split(/[.[\]]/).filter((s) => s !== "").map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

function getAt(obj, segments) {
  return segments.reduce((acc, seg) => (acc === null || acc === undefined ? undefined : acc[seg]), obj);
}

function setAt(root, segments, value) {
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (cursor[seg] === undefined || cursor[seg] === null) {
      cursor[seg] = typeof segments[i + 1] === "number" ? [] : {};
    }
    cursor = cursor[seg];
  }
  cursor[segments[segments.length - 1]] = value;
}

/**
 * Applies changes to a DEEP CLONE of labelData — never mutates the original.
 * §11.3's four ops: replace (set), append (push to array), remove (delete key
 * or splice array index), insert (splice into array at index).
 */
export function applyPatch(labelData, changes) {
  const candidate = JSON.parse(JSON.stringify(labelData));

  for (const change of changes) {
    const segments = parsePath(change.path);
    const parentSegments = segments.slice(0, -1);
    const lastSeg = segments[segments.length - 1];

    switch (change.op) {
      case "replace":
        setAt(candidate, segments, change.value);
        break;
      case "append": {
        const arr = getAt(candidate, segments);
        if (!Array.isArray(arr)) throw new Error(`Cannot "append" — "${change.path}" is not an array.`);
        arr.push(change.value);
        break;
      }
      case "insert": {
        const arr = getAt(candidate, parentSegments);
        if (!Array.isArray(arr)) throw new Error(`Cannot "insert" — parent of "${change.path}" is not an array.`);
        arr.splice(Number(lastSeg), 0, change.value);
        break;
      }
      case "remove": {
        const parent = getAt(candidate, parentSegments);
        if (Array.isArray(parent)) parent.splice(Number(lastSeg), 1);
        else if (parent && typeof parent === "object") delete parent[lastSeg];
        break;
      }
      default:
        throw new Error(`Unsupported op "${change.op}".`);
    }
  }

  return candidate;
}
