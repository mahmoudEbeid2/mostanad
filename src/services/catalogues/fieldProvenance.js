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
