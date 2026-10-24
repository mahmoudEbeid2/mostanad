import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";
import { loadVersion } from "../templates/templateService.js";
import { validateSource, validateFormat, sourceType, TEMPLATE_TOKEN_RE, productJsonColumns } from "../templates/sourceCatalogue.js";
import { getDictionary } from "../dictionary/dataDictionary.js";
import { parse, format, fromSource, resolve, normKey, isIdentifier, quoteKey } from "../paths/sourcePath.js";
import { getAiSettings, aiAllowed } from "../ai/aiSettings.js";
import { runLogged, logNotRun, sha16, stableStringify } from "../ai/aiRunLog.js";
import { recordSuggestion, clampConfidence } from "../ai/aiSuggestions.js";
import { recallMapping } from "./mappingMemory.js";
import { matchLabel, sampleAgrees } from "./dictionaryMatch.js";
import { inferFormat } from "./formatInference.js";
import { looksLikeBatchResult } from "./labelProposal.js";
import { publicAiError } from "../../ai/aiErrorMessage.js";

// Template field mapping (plan.md §5.2, §5.3). Per field, in order — each
// step short-circuits (P3):
//   1. memory      — the company confirmed this label before        (no AI)
//   2. dictionary  — the label is a single plausible dictionary hit  (no AI)
//   3. AI          — ONE CERT_FIELD_MAP call for every field still open,
//                    plus repeating-group bindings
// The model only CHOOSES (a dictionary path, a combination of dictionary
// paths, fixed text equal to the sample, manual); code validates every
// answer (P1, P5), adjusts its confidence against a sample product, records
// it as an AiSuggestion (P7) and decides pending / auto_accepted (P4).
// AI disabled, failing or over quota → steps 1–2 still run; the rest stays
// for the user (P8).

export const CATEGORIES = ["product_data", "invoice_line", "invoice_header", "company", "constant", "batch_data", "unknown"];
const AI_SOURCE_KINDS = ["item", "invoice", "product", "company", "brand", "static", "manual", "today", "template", "product_text"];
const MAX_DICTIONARY_ENTRIES = 200;
const MAX_SAMPLE_PRODUCTS = 5;
const MAX_JSON_CHARS = 4096;
const REQUIRED_MIN_COVERAGE = 0.5;

const INSTRUCTIONS = [
  "You map the variable values of a certificate design to the company's data.",
  "For every field you get its label, the printed sample value and the whole printed line.",
  "Choose where the value comes from — ONLY from what is given:",
  "- sourceKind item|invoice|product|company|brand with `path` copied EXACTLY from the dictionary below (never invent a path);",
  "- template: text with {{root.path}} placeholders, each copied exactly from the dictionary, for values combined from data plus fixed text (e.g. COA{{item.batchNo}});",
  "- static with `text` equal to the sample, for text that is the same on every certificate;",
  "- today, for the date the certificate is issued;",
  "- product_text with `path` (a dictionary path holding free text) and `extractLabel`, when the value is written inside a longer product text;",
  "- manual, when the value is in none of the data.",
  "category: batch_data for per-batch analysis/lab RESULTS (pH found, assay found, moisture…) that are not stored anywhere — those are manual;",
  "product_data, invoice_line (batch, dates, quantity of the invoiced line), invoice_header, company, constant, unknown otherwise.",
  "dateFormat (date values only): the printed pattern with tokens DD MM MMM YYYY YY, e.g. MM/YYYY.",
  "label: only when the given label is empty — a short human label for the value.",
  "confidence: 0–1, how sure you are. rationale: one short sentence.",
  "Repeating groups: pick the product collection (a dictionary path ending in []) whose elements fill the rows, and for each cell the child key.",
  "The raw JSON of some of the company's products is included so you can understand keys whose meaning is unclear.",
].join("\n");

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          label: { type: "string", nullable: true },
          sourceKind: { type: "string", enum: AI_SOURCE_KINDS },
          path: { type: "string", nullable: true },
          template: { type: "string", nullable: true },
          text: { type: "string", nullable: true },
          extractLabel: { type: "string", nullable: true },
          dateFormat: { type: "string", nullable: true },
          category: { type: "string", enum: CATEGORIES },
          confidence: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["key", "sourceKind", "category", "confidence", "rationale"],
      },
    },
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          collectionPath: { type: "string", nullable: true },
          cells: { type: "array", items: { type: "object", properties: { key: { type: "string" }, childPath: { type: "string", nullable: true } }, required: ["key"] } },
          confidence: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["key", "cells", "confidence", "rationale"],
      },
    },
  },
  required: ["fields"],
};

export const PROMPT_HASH = sha16(INSTRUCTIONS + JSON.stringify(RESPONSE_SCHEMA));

const defaultGenerate = (args) => geminiClient.generateJson({ ...args, ledger: { feature: "certificates.mapping" } });

// ── dictionary helpers ───────────────────────────────────────────────────────
const fullPath = (source) => fromSource(source);
const pickable = (entries) => entries.filter((e) => e.pickable !== false);

function entryFor(entries, path) {
  const p = parse(path);
  if (!p.ok) return null;
  const canon = `${p.root}.${format(p.segments)}`; // the dictionary's own spelling of the path
  const hit = entries.find((e) => e.pickable !== false && e.path === canon);
  if (hit) return hit;
  // one element of a collection the dictionary describes: activeIngredients[1].name
  // or [name="…"].name is valid when activeIngredients[].name was observed
  if (!p.segments.some((s) => s.t === "index" || s.t === "filter")) return null;
  let rel = ""; // spelled like the dictionary's collection paths (dataDictionary relPath)
  for (const s of p.segments) {
    if (s.t !== "key") rel += "[]";
    else rel += isIdentifier(s.k) ? (rel ? `.${s.k}` : s.k) : quoteKey(s.k);
  }
  const child = entries.find((e) => e.path === `${p.root}.${rel}`);
  return child && child.type !== "collection" ? { ...child, path: canon, label: canon, pickable: true } : null;
}

function sourceFromPath(path) {
  const p = parse(path);
  return { kind: p.root, path: String(path).slice(p.root.length + 1) };
}

/** The dictionary slice sent to the model: every non-product schema entry, then product entries by coverage (≤ 200). */
export function promptDictionary(entries) {
  const slim = (e) => ({ path: e.path, type: e.type, ...(typeof e.coverage === "number" ? { coverage: e.coverage } : {}), ...(e.examples?.length ? { examples: e.examples } : {}), labels: e.labels, ...(e.synonyms?.length ? { synonyms: e.synonyms } : {}) });
  const nonProduct = entries.filter((e) => e.root !== "product" && e.pickable !== false);
  const product = entries.filter((e) => e.root === "product").sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0));
  return [...nonProduct, ...product].slice(0, MAX_DICTIONARY_ENTRIES).map(slim);
}

const truncate = (v) => {
  const s = JSON.stringify(v);
  return s.length > MAX_JSON_CHARS ? `${s.slice(0, MAX_JSON_CHARS)}…` : s;
};

/** Raw JSON of up to 5 of the company's products (plan.md §5.2) — the caller's company only (P6). */
async function sampleProductsJson(companyId, sampleProductId) {
  const cols = [...productJsonColumns()];
  const select = Object.fromEntries([["id", true], ["name", true], ...cols.map((c) => [c, true])]);
  const rows = await prisma.product.findMany({ where: { companyId, OR: cols.map((c) => ({ [c]: { not: null } })) }, select, orderBy: { updatedAt: "desc" }, take: MAX_SAMPLE_PRODUCTS + 1 });
  const ordered = [...rows.filter((r) => r.id === sampleProductId), ...rows.filter((r) => r.id !== sampleProductId)].slice(0, MAX_SAMPLE_PRODUCTS);
  return ordered.map((r) => ({ name: r.name, ...Object.fromEntries(cols.filter((c) => r[c] !== null && r[c] !== undefined).map((c) => [c, truncate(r[c])])) }));
}

// ── validation of one AI field answer (P1, P5) ───────────────────────────────
/** → { source, format, category, confidence, rationale, label?, note? } or { invalid: reason, … } */
export function validateAiField(answer, field, entries) {
  const category = CATEGORIES.includes(answer.category) ? answer.category : "unknown";
  const base = { category, confidence: clampConfidence(answer.confidence), rationale: String(answer.rationale || "").slice(0, 300), ...(answer.label ? { label: String(answer.label).trim().slice(0, 80) } : {}) };
  const reject = (reason) => ({ ...base, invalid: reason, source: { kind: "manual" }, format: null, confidence: 0, category: "unknown" });
  let source;
  switch (answer.sourceKind) {
    case "item":
    case "invoice":
    case "product":
    case "company":
    case "brand": {
      const path = `${answer.sourceKind}.${String(answer.path || "").replace(new RegExp(`^${answer.sourceKind}\\.`), "")}`;
      const entry = entryFor(entries, path);
      if (!entry) return reject(`path "${answer.path}" is not in the company's data dictionary`);
      source = sourceFromPath(entry.path);
      break;
    }
    case "template": {
      const template = String(answer.template || "");
      const tokens = [...template.matchAll(TEMPLATE_TOKEN_RE)];
      if (!tokens.length) return reject("a combination needs placeholders");
      for (const [, k, p] of tokens) if (k !== "today" && !entryFor(entries, `${k}.${p || ""}`)) return reject(`placeholder {{${k}.${p || ""}}} is not in the dictionary`);
      source = { kind: "template", template };
      break;
    }
    case "static": {
      // fixed text must be what is printed — the model never writes content (plan.md §1 non-goals)
      const text = String(answer.text ?? field.sampleValue);
      if (text !== field.sampleValue) return reject("fixed text must equal the printed sample");
      source = { kind: "static", text };
      break;
    }
    case "today":
      source = { kind: "today" };
      break;
    case "product_text": {
      // the per-product extraction + verbatim check is A2 (plan.md §6.1); until
      // then the field stays manual and the proposal is kept for the user
      const entry = entryFor(entries, `product.${String(answer.path || "").replace(/^product\./, "")}`);
      if (!entry || !answer.extractLabel) return reject("product_text needs a dictionary path and an extractLabel");
      return { ...base, source: { kind: "manual" }, format: null, note: `the value is written inside ${entry.label} (after “${answer.extractLabel}”) — reading it from there comes with invoice intelligence (A2)` };
    }
    case "manual":
      source = { kind: "manual" };
      break;
    default:
      return reject(`unknown sourceKind "${answer.sourceKind}"`);
  }
  if (validateSource(source).length) return reject(validateSource(source)[0]);
  let format = null;
  if (answer.dateFormat && sourceType(source) === "date") {
    format = { date: answer.dateFormat };
    if (validateFormat(format, source).length) format = null;
  }
  if (!format) format = inferFormat(field.sampleValue, sourceType(source)).format;
  if (format && validateFormat(format, source).length) format = null;
  return { ...base, source, format };
}

// ── the chain ────────────────────────────────────────────────────────────────
const noteAmbiguousDate = (sample, type) => inferFormat(sample, type).ambiguousDate || null;

function requiredFor(source, entries) {
  const p = fullPath(source);
  const e = p ? entryFor(entries, p) : null;
  return !(e && typeof e.coverage === "number" && e.coverage < REQUIRED_MIN_COVERAGE);
}

function codeCategory(source) {
  switch (source.kind) {
    case "item":
      return "invoice_line";
    case "invoice":
      return "invoice_header";
    case "product":
    case "brand":
      return "product_data";
    case "company":
      return "company";
    case "static":
      return "constant";
    default:
      return null;
  }
}

/** Plausibility vs a sample product (plan.md §5.2 step 5) → { confidence, evidence } */
function plausibility(source, sample, sampleCtx, confidence) {
  const path = fullPath(source);
  if (!path || !sampleCtx) return { confidence, evidence: null };
  const agrees = sampleAgrees(path, sample, sampleCtx);
  if (agrees === true) return { confidence: Math.max(confidence, 0.97), evidence: { type: "sample_product", text: "matches the sample product's value" } };
  if (agrees === false) {
    const r = resolve(sampleCtx, path);
    return { confidence: confidence * 0.6, evidence: { type: "sample_product", text: r.found ? `the sample product has “${String(r.value).slice(0, 60)}”, not the printed sample` : "the sample product has no value here" } };
  }
  return { confidence, evidence: null };
}

/** Deterministic group binding: the sample product's collection whose element holds every cell's sample. */
function bindGroupByCode(group, cells, entries, sampleCtx) {
  if (!sampleCtx?.product) return null;
  const hits = [];
  for (const coll of entries.filter((e) => e.type === "collection" && e.root === "product")) {
    const listPath = coll.path.slice("product.".length, -2);
    const list = resolve(sampleCtx, `product.${listPath}`).value;
    if (!Array.isArray(list)) continue;
    const children = entries.filter((e) => e.path.startsWith(`${coll.path}.`)).map((e) => e.path.slice(coll.path.length + 1)).filter((k) => !k.includes("["));
    for (const el of list) {
      if (!el || typeof el !== "object") continue;
      const map = {};
      for (const c of cells) {
        const child = children.find((k) => {
          const actual = Object.keys(el).find((x) => normKey(x) === normKey(k));
          return actual !== undefined && sampleAgreesValue(el[actual], c.sampleValue);
        });
        if (!child) break;
        map[c.key] = child;
      }
      if (Object.keys(map).length === cells.length) {
        hits.push({ listPath, map });
        break;
      }
    }
  }
  if (hits.length !== 1) return null;
  return { source: { kind: "product_list", path: hits[0].listPath }, cells: Object.fromEntries(Object.entries(hits[0].map).map(([k, child]) => [k, { kind: "row", path: child }])), confidence: 0.97, rationale: "the sample product's list holds every cell's sample in one element" };
}
const sampleAgreesValue = (v, sample) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase() === String(sample ?? "").replace(/\s+/g, " ").trim().toLowerCase();

function validateAiGroup(answer, cells, entries) {
  const coll = entries.find((e) => e.type === "collection" && e.root === "product" && (e.path === `product.${String(answer.collectionPath || "").replace(/^product\./, "").replace(/\[\]$/, "")}[]`));
  if (!coll) return { invalid: `collection "${answer.collectionPath}" is not in the dictionary` };
  const children = new Set(entries.filter((e) => e.path.startsWith(`${coll.path}.`)).map((e) => e.path.slice(coll.path.length + 1)));
  const map = {};
  for (const c of cells) {
    const a = (answer.cells || []).find((x) => x.key === c.key);
    if (!a?.childPath || !children.has(a.childPath)) return { invalid: `cell ${c.key}: "${a?.childPath}" is not a key of ${coll.label}` };
    map[c.key] = { kind: "row", path: a.childPath };
  }
  return { source: { kind: "product_list", path: coll.path.slice("product.".length, -2) }, cells: map, confidence: clampConfidence(answer.confidence), rationale: String(answer.rationale || "").slice(0, 300) };
}

/**
 * POST /template-versions/:id/map-fields
 * input: { fields: [{ key, label, lineId, sampleValue, groupKey? }], groups?: [{ key, label }], keys?: [..], sampleProductId? }
 * → { mappings: { [key]: Mapping }, groups: { [key]: Binding }, ai: { used, calls, unavailable?, reason? }, dictionaryVersion }
 * deps.generate replaces the model call (tests).
 */
export async function mapFields(versionId, scopeCompanyId, input, { userId = null, generate = defaultGenerate } = {}) {
  const version = await loadVersion(versionId, scopeCompanyId);
  if (version.status !== "draft") throw new CertError("VERSION_NOT_DRAFT", "Fields can only be mapped while marking them (draft)", 409);
  const companyId = version.template.companyId;
  const typeId = version.template.certificateTypeId;
  const lines = new Map((version.lines || []).map((l) => [l.id, l]));
  const all = (input.fields || []).filter((f) => f && f.key);
  const wanted = new Set(input.keys?.length ? input.keys : all.map((f) => f.key));
  const fields = all.filter((f) => wanted.has(f.key) && !f.groupKey);
  const groupCells = (g) => all.filter((f) => f.groupKey === g.key);
  const groups = (input.groups || []).filter((g) => g?.key && groupCells(g).length && (!input.keys?.length || wanted.has(g.key)));

  let sampleCtx = null;
  if (input.sampleProductId) {
    const product = await prisma.product.findFirst({ where: { id: input.sampleProductId, companyId }, include: { category: { select: { name: true } }, brand: { select: { name: true } } } });
    if (!product) throw notFound("Product");
    sampleCtx = { product, brand: product.brand };
  }
  const dict = await getDictionary(companyId);
  const entries = dict.entries;
  const settings = await getAiSettings(companyId);
  const mappings = {};
  const bindings = {};
  const open = [];

  for (const f of fields) {
    const type = (s) => sourceType(s);
    // 1. memory
    const mem = await recallMapping(companyId, f.label, typeId);
    if (mem) {
      mappings[f.key] = { source: mem.source, format: mem.format ?? null, category: mem.category || codeCategory(mem.source) || "unknown", required: requiredFor(mem.source, entries), origin: "memory", confidence: 1, status: "accepted", rationale: `you mapped “${f.label}” this way before (${mem.timesUsed}×)` };
      continue;
    }
    // per-batch lab results (code): manual, asked at invoice review (A2)
    if (looksLikeBatchResult({ label: f.label, context: f.labelContext })) {
      mappings[f.key] = { source: { kind: "manual" }, format: null, category: "batch_data", required: true, origin: "dictionary", confidence: 0.95, status: "accepted", rationale: "a per-batch result — it isn't in your data and will be asked during invoice review" };
      continue;
    }
    // 2. dictionary
    const hit = matchLabel({ label: f.label, sampleValue: f.sampleValue, entries: pickable(entries), sampleCtx });
    if (hit?.entry) {
      const source = sourceFromPath(hit.entry.path);
      const inferred = inferFormat(f.sampleValue, type(source));
      mappings[f.key] = {
        source,
        format: inferred.format,
        ...(inferred.ambiguousDate ? { ambiguousDate: inferred.ambiguousDate } : {}),
        category: codeCategory(source) || "unknown",
        required: requiredFor(source, entries),
        origin: "dictionary",
        confidence: hit.confidence,
        status: "accepted",
        rationale: hit.rationale,
        evidence: { type: "dictionary", entry: { path: hit.entry.path, label: hit.entry.label, coverage: hit.entry.coverage ?? null, examples: hit.entry.examples || [] } },
      };
      continue;
    }
    open.push({ ...f, ambiguous: hit?.ambiguous || null });
  }

  // groups: code binding first
  const openGroups = [];
  for (const g of groups) {
    const b = bindGroupByCode(g, groupCells(g), entries, sampleCtx);
    if (b) bindings[g.key] = { ...b, origin: "dictionary", status: "accepted" };
    else openGroups.push(g);
  }

  const ai = { used: false, calls: 0 };
  if (open.length || openGroups.length) {
    if (!aiAllowed(settings)) {
      ai.unavailable = true;
      ai.reason = "AI is turned off for this company";
      await logNotRun({ companyId, kind: "CERT_FIELD_MAP", outcome: "disabled", reason: ai.reason, entityType: "template_version", entityId: versionId, promptHash: PROMPT_HASH });
    } else {
      const payload = {
        allowedRoots: ["product", "item", "invoice", "company", "brand", "static", "manual", "today", "template"],
        dictionary: promptDictionary(entries),
        productSamples: await sampleProductsJson(companyId, input.sampleProductId),
        fields: open.map((f) => ({
          key: f.key,
          label: f.label || "",
          sampleValue: f.sampleValue,
          lineText: lines.get(f.lineId)?.text || "",
          neighbourLabels: [...new Set([f.labelContext?.columnHeader, ...(f.labelContext?.rowCells || [])].filter((x) => x && x !== f.sampleValue))].slice(0, 6),
          ...(f.ambiguous ? { candidates: f.ambiguous } : {}),
        })),
        groups: openGroups.map((g) => ({ key: g.key, label: g.label, cells: groupCells(g).map((c) => ({ key: c.key, label: c.label, sampleValue: c.sampleValue })) })),
      };
      // large shared content first (CLAUDE.md prompt order): instructions → dictionary → samples → fields
      const contents = [INSTRUCTIONS, `Dictionary:\n${JSON.stringify(payload.dictionary)}`, `Product samples:\n${JSON.stringify(payload.productSamples)}`, `Fields:\n${JSON.stringify({ fields: payload.fields, groups: payload.groups })}`];
      try {
        const { result, run } = await runLogged(
          { companyId, kind: "CERT_FIELD_MAP", promptHash: PROMPT_HASH, input: payload, entityType: "template_version", entityId: versionId, reason: `${open.length} field(s), ${openGroups.length} group(s) not resolved by memory or dictionary` },
          () => generate({ model: MODELS.CERT_FIELD_MAP.id, temperature: MODELS.CERT_FIELD_MAP.temperature, thinkingBudget: MODELS.CERT_FIELD_MAP.thinkingBudget, contents, schema: RESPONSE_SCHEMA, maxOutputTokens: 8192 })
        );
        ai.used = true;
        ai.calls = 1;
        const inputHash = sha16(stableStringify(payload));
        for (const f of open) {
          const answer = (result?.fields || []).find((a) => a.key === f.key);
          if (!answer) {
            mappings[f.key] = { source: { kind: "manual" }, format: null, category: "unknown", required: true, origin: "none", confidence: 0, status: "unmapped", rationale: "the AI gave no answer for this field" };
            continue;
          }
          const v = validateAiField(answer, f, entries);
          const plaus = v.invalid ? { confidence: 0, evidence: null } : plausibility(v.source, f.sampleValue, sampleCtx, v.confidence);
          const proposal = { source: v.source, format: v.format ?? null, category: v.category, ...(v.label ? { label: v.label } : {}), ...(v.note ? { note: v.note } : {}), raw: answer };
          const suggestion = await recordSuggestion(
            {
              companyId,
              kind: "field_map",
              entityType: "template_field",
              entityId: `${versionId}:${f.key}`,
              proposal,
              evidence: plaus.evidence ? [plaus.evidence] : undefined,
              evidenceVerified: plaus.evidence ? plaus.confidence >= v.confidence : null,
              confidence: plaus.confidence,
              modelKind: "CERT_FIELD_MAP",
              promptHash: PROMPT_HASH,
              inputHash,
              dictionaryVersion: dict.version,
              aiRunId: run?.id,
            },
            settings
          );
          if (v.invalid) {
            await prisma.aiSuggestion.update({ where: { id: suggestion.id }, data: { status: "rejected", finalValue: { reason: v.invalid } } });
            mappings[f.key] = { source: { kind: "manual" }, format: null, category: "unknown", required: true, origin: "none", confidence: 0, status: "invalid", rationale: `the AI's answer was refused: ${v.invalid}`, suggestionId: suggestion.id };
            continue;
          }
          const dateAmbiguity = !v.format?.date ? noteAmbiguousDate(f.sampleValue, sourceType(v.source)) : null;
          mappings[f.key] = {
            source: v.source,
            format: v.format,
            ...(dateAmbiguity ? { ambiguousDate: dateAmbiguity } : {}),
            category: v.category === "unknown" ? codeCategory(v.source) || "unknown" : v.category,
            required: requiredFor(v.source, entries),
            origin: "ai",
            confidence: Math.round(plaus.confidence * 100) / 100,
            status: suggestion.status, // pending | auto_accepted
            rationale: v.rationale,
            ...(v.note ? { note: v.note } : {}),
            ...(v.label && !f.label ? { label: v.label } : {}),
            evidence: plaus.evidence,
            suggestionId: suggestion.id,
          };
        }
        for (const g of openGroups) {
          const answer = (result?.groups || []).find((a) => a.key === g.key);
          if (!answer) continue;
          const v = validateAiGroup(answer, groupCells(g), entries);
          const suggestion = await recordSuggestion(
            { companyId, kind: "group_binding", entityType: "template_field", entityId: `${versionId}:group:${g.key}`, proposal: { ...v, raw: answer }, confidence: v.invalid ? 0 : v.confidence, modelKind: "CERT_FIELD_MAP", promptHash: PROMPT_HASH, inputHash, dictionaryVersion: dict.version, aiRunId: run?.id },
            settings
          );
          if (v.invalid) {
            await prisma.aiSuggestion.update({ where: { id: suggestion.id }, data: { status: "rejected", finalValue: { reason: v.invalid } } });
            bindings[g.key] = { status: "invalid", rationale: `the AI's answer was refused: ${v.invalid}`, suggestionId: suggestion.id };
          } else bindings[g.key] = { ...v, origin: "ai", status: suggestion.status, suggestionId: suggestion.id };
        }
      } catch (err) {
        // P8: the AI path never blocks the wizard — what code resolved stands
        ai.unavailable = true;
        ai.reason = publicAiError(err);
      }
    }
  }
  for (const f of open) {
    if (!mappings[f.key]) mappings[f.key] = { source: { kind: "manual" }, format: null, category: "unknown", required: true, origin: "none", confidence: 0, status: "unmapped", rationale: ai.unavailable ? `not mapped: ${ai.reason}` : "not mapped", ...(f.ambiguous ? { candidates: f.ambiguous } : {}) };
  }
  return { mappings, groups: bindings, ai, dictionaryVersion: dict.version };
}

/** GET /ai-suggestions/:id — the "Why?" of a mapping (tenant-scoped). */
export async function getSuggestion(id, scopeCompanyId) {
  const s = await prisma.aiSuggestion.findUnique({ where: { id } });
  if (!s || (scopeCompanyId && s.companyId !== scopeCompanyId)) throw notFound("Suggestion");
  return s;
}
