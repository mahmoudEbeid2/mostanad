import { normLabel } from "./labelProposal.js";
import { plausibleForType } from "./formatInference.js";
import { parse, resolve, ROOTS } from "../paths/sourcePath.js";

// Dictionary match (plan.md §5.2 step 2) — code, no AI. A field's label is
// compared with every dictionary entry's labels, synonyms and key words; a
// match is used only when it is the SINGLE best hit and the sample value is
// plausible for the entry (type; when a sample product is known, its value
// equals the sample). Anything ambiguous goes to the AI instead of a guess.

// abbreviations that mean the same word on certificates
const TOKEN_CANON = { no: "number", nr: "number", num: "number", nbr: "number", qty: "quantity", mfd: "mfg" };
export const canonLabel = (s) =>
  normLabel(s)
    .split(" ")
    .map((t) => TOKEN_CANON[t] ?? t)
    .join(" ");

const camelWords = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, "$1 $2");
const ROOT_WORDS = { product: "product", item: "", invoice: "invoice", company: "company", brand: "brand" };

/** Every way an entry may be written on a certificate (canonical form). */
export function entryKeys(entry) {
  const keys = new Set();
  const add = (s) => {
    const c = canonLabel(s);
    if (c) keys.add(c);
  };
  for (const l of entry.labels || []) add(l);
  for (const s of entry.synonyms || []) add(s);
  const p = parse(entry.path);
  if (p.ok) {
    const named = p.segments.filter((s) => s.t === "key").map((s) => s.k);
    const last = named[named.length - 1];
    if (last && !p.segments.some((s) => s.t === "filter")) {
      add(camelWords(last));
      // "product name", "company address" (a direct column only: product.brand.name
      // is not "product name"); and "category" for category.name
      if (ROOT_WORDS[p.root] && named.length === 1) add(`${ROOT_WORDS[p.root]} ${camelWords(last)}`);
      if (named.length >= 2 && last === "name") add(camelWords(named[named.length - 2]));
    }
  }
  return keys;
}

const normValue = (v) =>
  String(v ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** Does `path` on the sample context yield `sample`? → true | false | null (unknown: no sample context / not resolvable there). */
export function sampleAgrees(path, sample, sampleCtx) {
  if (!sampleCtx) return null;
  const root = parse(path).root;
  if (!sampleCtx[root]) return null;
  const r = resolve(sampleCtx, path);
  if (!r.found) return false;
  const v = Array.isArray(r.value) ? r.value.join(", ") : String(r.value);
  return normValue(v) === normValue(sample);
}

/**
 * label + sample → { entry, confidence, rationale } | { ambiguous: [paths] } | null
 * entries: dictionary entries (pickable ones are considered).
 * sampleCtx: optional resolver context with the template's sample product.
 */
export function matchLabel({ label, sampleValue, entries, sampleCtx = null }) {
  const want = canonLabel(label);
  if (!want) return null;
  const hits = entries.filter((e) => e.pickable !== false && ROOTS.includes(e.root) && entryKeys(e).has(want) && plausibleForType(sampleValue, e.type === "number" ? "number" : e.type === "date" ? "date" : "string"));
  if (!hits.length) return null;
  const agreeing = hits.filter((e) => sampleAgrees(e.path, sampleValue, sampleCtx) === true);
  const pool = agreeing.length ? agreeing : hits.filter((e) => sampleAgrees(e.path, sampleValue, sampleCtx) !== false);
  if (pool.length !== 1) return { ambiguous: (pool.length ? pool : hits).map((e) => e.path) };
  const entry = pool[0];
  const agrees = agreeing.length === 1;
  return {
    entry,
    confidence: agrees ? 0.98 : 0.9,
    rationale: `label “${label}” matches ${entry.label}${agrees ? "; the sample product's value equals the sample" : ""}`,
  };
}
