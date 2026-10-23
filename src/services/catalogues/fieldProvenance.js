// Per-field provenance on a product (plan.md §15.3 step 7; owner rules for A6):
//   product.fieldProvenance[path] = { tier: "C", catalogueVersionId, blockId, page, quote, at }
//                                 | { tier: "I", estimated: true, basis, modelId, promptHash, at }
//   + confirmedAt (and confirmedByUserId, for a system user) once a person signed for it.
// `path` is the product path relative to `product.` ("storage", "withdrawalPeriod",
// "specifications.values.Assay"). An estimated value is never used in a
// certificate until a person confirmed it: certificate contexts read the product
// through maskEstimates, which empties every unconfirmed estimate.

// confirmedAt is what marks a signature (confirmedByUserId is null for a company session)
export const isUnconfirmedEstimate = (p) => !!p && p.estimated === true && !p.confirmedAt;

/** Unconfirmed estimates of a product → { [path]: provenance } */
export function estimatesOf(product) {
  const out = {};
  for (const [path, p] of Object.entries(product?.fieldProvenance || {})) if (isUnconfirmedEstimate(p)) out[path] = p;
  return out;
}

function clearPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur !== "object") return;
    cur[parts[i]] = Array.isArray(cur[parts[i]]) ? [...cur[parts[i]]] : cur[parts[i]] && typeof cur[parts[i]] === "object" ? { ...cur[parts[i]] } : cur[parts[i]];
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === "object") cur[parts[parts.length - 1]] = Array.isArray(cur[parts[parts.length - 1]]) ? [] : null;
}

/** The product as certificates may read it: every unconfirmed estimate emptied (a copy; null stays null). */
export function maskEstimates(product) {
  if (!product) return product;
  const est = Object.keys(estimatesOf(product));
  if (!est.length) return product;
  const copy = { ...product };
  for (const path of est) clearPath(copy, path);
  return copy;
}

/** The provenance entry, if any, that covers a resolved product path ("product.storage" / "storage"). */
export function provenanceFor(product, fullPath) {
  const rel = String(fullPath || "").replace(/^product\./, "");
  const fp = product?.fieldProvenance || {};
  if (fp[rel]) return { path: rel, ...fp[rel] };
  const column = rel.split(/[.[]/)[0];
  return fp[column] ? { path: column, ...fp[column] } : null;
}

// key order doesn't count (jsonb stores keys in its own order); "", [] and null are all "empty"
const canonical = (v) => {
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return null;
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * A person edited the product: every field whose value changed and that carried a
 * catalogue/estimate provenance is now the person's value ({ tier: "manual" }) —
 * an edited estimate is no longer an estimate, and a catalogue quote no longer
 * vouches for it. → the new fieldProvenance, or undefined when nothing changes.
 */
export function provenanceAfterEdit(existing, updates) {
  const fp = existing?.fieldProvenance;
  if (!fp || typeof fp !== "object") return undefined;
  let changed = false;
  const next = { ...fp };
  for (const [path, p] of Object.entries(fp)) {
    const column = path.split(".")[0];
    if (!(column in updates) || p?.tier === "manual") continue;
    const before = path.split(".").reduce((o, k) => (o == null ? o : o[k]), existing);
    const after = path.split(".").reduce((o, k) => (o == null ? o : o[k]), updates);
    if (same(before, after)) continue;
    next[path] = { tier: "manual", at: new Date().toISOString(), replaced: p.tier };
    changed = true;
  }
  return changed ? next : undefined;
}
