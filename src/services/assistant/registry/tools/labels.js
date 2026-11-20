import { z } from "zod";
import { defineTool } from "../registry.js";
import { page, ref } from "../trim.js";
import { pageArgs, id, pg } from "./common.js";
import { getAll as listLabels, getById as getLabelById, getLatestValidation, getReviewInbox } from "../../../label/generatedLabelService.js";
import { listReferenceLabels, listRegulatoryDocuments, getRegulatoryDocument } from "../../reads.js";
import { getApprovedRulesForCountry } from "../../../label/regulatory/regulatoryDocumentService.js";

const LABEL_STATUSES = ["draft", "validated", "failed_validation", "approved", "revoked", "archived"];
const verdictCounts = (verdicts = []) => verdicts.reduce((m, v) => ({ ...m, [v.status]: (m[v.status] || 0) + 1 }), {});

// ── generated labels ────────────────────────────────────────────────────────
defineTool({
  name: "search_labels",
  module: "labels",
  risk: "read",
  permissions: ["read_labels"],
  label: "Listing labels",
  description: `Generated product labels, newest first, optionally for one product or with one status (${LABEL_STATUSES.join(", ")}). Each: id, product, country, language, status, version, risk score.`,
  args: z.object({ productId: z.string().uuid().optional(), status: z.enum(LABEL_STATUSES).optional(), ...pageArgs }),
  run: async (a, ctx) => {
    const { page: p, limit } = pg(a);
    if (a.status) {
      // the service has no status filter: read a wider page and filter it here
      const { labels } = await listLabels({ page: 1, limit: 200, companyId: ctx.companyId || undefined, productId: a.productId });
      const rows = labels.filter((l) => l.status === a.status);
      return page(rows.slice((p - 1) * limit, p * limit).map((l) => ({ ...l, ref: ref("label", l, `Label ${l.country}`) })), rows.length, { page: p, limit });
    }
    const { labels, total } = await listLabels({ page: p, limit, companyId: ctx.companyId || undefined, productId: a.productId });
    return page(labels.map((l) => ({ ...l, ref: ref("label", l, `Label ${l.country}`) })), total, { page: p, limit });
  },
});

defineTool({
  name: "get_label",
  module: "labels",
  risk: "read",
  permissions: ["read_labels"],
  label: "Reading the label",
  description: "One generated label: status, country, language, version, risk, the label content (fields), and its latest validation summary (passed, errors, warnings, verdict counts).",
  args: z.object({ labelId: id("label") }),
  run: async (a, ctx) => {
    const { label, latestValidation } = await getLabelById(a.labelId, { companyId: ctx.companyId || undefined });
    return {
      id: label.id, productId: label.productId, status: label.status, country: label.country, language: label.language, currentVersion: label.currentVersion, riskScore: label.riskScore, autonomyTier: label.autonomyTier, needsReview: label.needsReview,
      content: label.labelData,
      validation: latestValidation ? { passed: latestValidation.passed, errorCount: latestValidation.errorCount, warningCount: latestValidation.warningCount, versionNumber: latestValidation.versionNumber, verdicts: verdictCounts(latestValidation.verdicts), at: latestValidation.createdAt } : null,
      ref: ref("label", label, `Label ${label.country}`),
    };
  },
});

defineTool({
  name: "get_label_validation",
  module: "labels",
  risk: "read",
  permissions: ["read_labels"],
  label: "Reading the validation",
  description: "The latest validation report of a label: each verdict (rule, status PASS/FAIL/NEEDS_REVIEW/UNVERIFIABLE, message). UNVERIFIABLE is its own verdict — never report it as passed.",
  args: z.object({ labelId: id("label"), onlyProblems: z.boolean().optional().describe("Only verdicts that are not PASS (default true)") }),
  run: async (a, ctx) => {
    const r = await getLatestValidation(a.labelId, { companyId: ctx.companyId || undefined });
    const verdicts = (r.verdicts || []).filter((v) => a.onlyProblems === false || v.status !== "PASS");
    return { passed: r.passed, errorCount: r.errorCount, warningCount: r.warningCount, versionNumber: r.versionNumber, counts: verdictCounts(r.verdicts), verdicts: verdicts.map((v) => ({ ruleKey: v.ruleKey, status: v.status, path: v.path || v.targetPath, message: v.message || v.reason })), at: r.createdAt };
  },
});

defineTool({
  name: "get_label_review_inbox",
  module: "labels",
  risk: "read",
  permissions: ["read_assurance"],
  label: "Reading the review inbox",
  description: "Labels waiting for a person's review (validated or failed validation), highest risk first.",
  args: z.object({ ...pageArgs }),
  run: async (a, ctx) => {
    const { page: p, limit } = pg(a);
    const { labels, total } = await getReviewInbox({ companyId: ctx.companyId || undefined, page: p, limit });
    return page(labels.map((l) => ({ ...l, ref: ref("label", l, `Label ${l.country}`) })), total, { page: p, limit });
  },
});

defineTool({
  name: "search_reference_labels",
  module: "labels",
  risk: "read",
  permissions: ["read_labels"],
  label: "Listing reference labels",
  description: "Approved reference labels the label engine learns from (the company's own and the shared ones), by name and country.",
  args: z.object({ q: z.string().max(80).optional(), country: z.string().max(60).optional(), ...pageArgs }),
  run: async (a, ctx) => {
    const { page: p, limit } = pg(a);
    const { total, rows } = await listReferenceLabels(ctx.companyId, { ...a, page: p, limit });
    return page(rows.map((r) => ({ id: r.id, name: r.name, country: r.country, shared: !r.companyId })), total, { page: p, limit });
  },
});

// ── regulatory ──────────────────────────────────────────────────────────────
defineTool({
  name: "list_regulatory_documents",
  module: "regulatory",
  risk: "read",
  permissions: ["read_regulatory"],
  label: "Listing regulatory documents",
  description: "Regulatory documents (EDA, SFDA, …): title, authority, country, status, version, coverage, rule count. Filter by country, authority, status, or title text `q`.",
  args: z.object({ country: z.string().max(60).optional(), authority: z.string().max(30).optional(), status: z.string().max(30).optional(), q: z.string().max(80).optional(), ...pageArgs }),
  run: async (a, ctx) => {
    const { page: p, limit } = pg(a);
    const { total, rows } = await listRegulatoryDocuments(ctx.companyId, { ...a, page: p, limit });
    return page(rows.map(({ _count, companyId, ...d }) => ({ ...d, rules: _count.rules, shared: !companyId })), total, { page: p, limit });
  },
});

defineTool({
  name: "get_regulatory_document",
  module: "regulatory",
  risk: "read",
  permissions: ["read_regulatory"],
  label: "Reading the regulatory document",
  description: "One regulatory document: source, status, coverage, and its rules (key, type, severity, status, description, verbatim citation). Up to 40 rules are listed.",
  args: z.object({ documentId: id("regulatory document") }),
  run: async (a, ctx) => {
    const { _count, companyId, ...d } = await getRegulatoryDocument(a.documentId, ctx.companyId);
    return { ...d, ruleCount: _count.rules, shared: !companyId };
  },
});

defineTool({
  name: "get_eda_requirements",
  module: "regulatory",
  risk: "read",
  permissions: ["read_regulatory"],
  label: "Reading the requirements",
  description: "The approved regulatory rules in force for a country (default Egypt / EDA) that labels are validated against: rule key, type, severity, description, citation.",
  args: z.object({ country: z.string().max(60).optional().describe("Country name as stored, e.g. Egypt"), ...pageArgs }),
  run: async (a, ctx) => {
    const { page: p, limit } = pg(a);
    const rules = await getApprovedRulesForCountry(a.country || "Egypt", { companyId: ctx.companyId || undefined });
    const rows = rules.map((r) => ({ id: r.id, ruleKey: r.ruleKey, ruleType: r.ruleType, severity: r.severity, description: r.description, citation: r.citation }));
    return page(rows.slice((p - 1) * limit, p * limit), rows.length, { page: p, limit });
  },
});
