import crypto from "crypto";
import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { CertError } from "../errors.js";
import { loadVersion } from "./templateService.js";
import { listFields } from "./fieldService.js";
import { getSourceCatalogue, validateSource, validateFormat } from "./sourceCatalogue.js";
import { runLogged } from "../ai/aiRunLog.js";

// Optional AI assistance for marking fields (CERTIFICATES_V2_PLAN.md §8.3, D3,
// D10). The model receives the version's line TEXTS only — template HTML never
// leaves the server (§14). It never writes HTML and never decides which fields
// exist: every suggestion is a chip the user accepts or rejects, and an
// accepted one is stored `origin: "ai_suggested", confirmed: false` until the
// user confirms it (activation is refused before that).
//
// Disabled with CERT_ASSIST_ENABLED=false (plan §20 I9).

export const assistEnabled = () => process.env.CERT_ASSIST_ENABLED !== "false";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          lineId: { type: "string" },
          value: { type: "string", description: "the exact variable text, copied character for character from the line" },
          label: { type: "string" },
          sourceKind: { type: "string", enum: ["item", "invoice", "product", "company", "brand", "today", "manual"] },
          sourcePath: { type: "string", nullable: true },
          dateFormat: { type: "string", nullable: true },
        },
        required: ["lineId", "value", "label", "sourceKind"],
      },
    },
  },
  required: ["suggestions"],
};

function prompt(lines, catalogue) {
  const sources = catalogue.kinds
    .filter((k) => k.paths)
    .map((k) => `${k.kind}: ${k.paths.map((p) => p.path).join(", ")}`)
    .join("\n");
  return [
    "You are helping a user mark the VARIABLE values in a certificate design: values that change from one certificate to the next",
    "(batch numbers, dates, product names, results, document numbers). Fixed labels and headings are NOT variable.",
    "For each variable value return: the line id, the value copied EXACTLY from the line text, a short human label,",
    "and the most likely data source (kind + path) from this catalogue, or kind 'manual' when none fits.",
    "For dates also return the date format using tokens DD MM MMM YYYY YY (e.g. MM/YYYY).",
    "",
    "Source catalogue:",
    sources,
    "",
    "Lines (id: text):",
    ...lines.map((l) => `${l.id}: ${l.text}`),
  ].join("\n");
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 50) || "field";

/**
 * POST /template-versions/:id/suggest → { suggestions[], provenance }
 * Each suggestion is a complete field draft (offsets resolved and checked here).
 */
export async function suggestFields(versionId, companyId) {
  if (!assistEnabled()) throw new CertError("ASSIST_DISABLED", "AI field suggestions are turned off", 403);
  const version = await loadVersion(versionId, companyId);
  if (version.status !== "draft") throw new CertError("VERSION_NOT_DRAFT", "Suggestions are only available while marking fields (draft)", 409);
  const lines = (version.lines || []).filter((l) => l.text.trim());
  const catalogue = getSourceCatalogue();
  const text = prompt(lines, catalogue);
  const promptHash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  const t0 = Date.now();
  const { result: out } = await runLogged(
    { companyId: version.template.companyId, kind: "CERT_ASSIST", promptHash, input: text, entityType: "template_version", entityId: versionId, reason: "suggest fields" },
    () =>
      geminiClient.generateJson({
        ledger: { feature: "certificates.assist" },
        model: MODELS.CERT_ASSIST.id,
        temperature: MODELS.CERT_ASSIST.temperature,
        thinkingBudget: MODELS.CERT_ASSIST.thinkingBudget,
        contents: [text],
        schema: RESPONSE_SCHEMA,
      })
  );

  const existing = await listFields(versionId);
  const taken = new Set(existing.map((f) => f.key));
  const used = existing.map((f) => ({ lineId: f.lineId, start: f.charStart, end: f.charEnd }));
  const byLine = new Map(lines.map((l) => [l.id, l]));
  const suggestions = [];
  const rejected = [];
  for (const s of out?.suggestions || []) {
    const line = byLine.get(s.lineId);
    const value = String(s.value || "").trim();
    if (!line || !value) {
      rejected.push({ ...s, reason: "unknown line or empty value" });
      continue;
    }
    // the value must literally be in the line, at a range nobody uses yet
    let start = -1;
    for (let from = 0; ; from = start + 1) {
      start = line.text.indexOf(value, from);
      if (start < 0) break;
      const end = start + value.length;
      if (!used.some((u) => u.lineId === line.id && start < u.end && u.start < end)) break;
    }
    if (start < 0) {
      rejected.push({ ...s, reason: "value not found in the line" });
      continue;
    }
    let key = slug(s.label || value);
    for (let n = 2; taken.has(key); n++) key = `${slug(s.label || value)}_${n}`;
    taken.add(key);
    used.push({ lineId: line.id, start, end: start + value.length });

    let source = { kind: s.sourceKind, ...(s.sourcePath ? { path: s.sourcePath } : {}) };
    if (validateSource(source).length) source = { kind: "manual" };
    let format = s.dateFormat ? { date: s.dateFormat } : null;
    if (format && validateFormat(format, source).length) format = null;

    suggestions.push({
      key,
      label: String(s.label || key).slice(0, 80),
      lineId: line.id,
      page: line.page || 1,
      charStart: start,
      charEnd: start + value.length,
      sampleValue: value,
      source,
      format,
      required: true,
      align: "left",
      origin: "ai_suggested",
      confirmed: false,
    });
  }
  return {
    suggestions,
    rejected: rejected.length,
    provenance: { modelId: MODELS.CERT_ASSIST.id, promptHash, ms: Date.now() - t0, at: new Date().toISOString() },
  };
}
