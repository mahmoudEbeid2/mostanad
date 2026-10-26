// Shared by a3.matching.test.js (stand-in model) and scripts/evalCertMatching.js
// (live Gemini, opt-in): seeds a company with the golden catalogue (and another
// company with look-alike products), loads the golden supplier invoices as
// extraction leaves them, runs the matcher and scores it against
// fixtures/certificates/matching/goldens.json (plan.md §7 acceptance).
// Not a test file itself (runAll only runs *.test.js).
import fs from "fs";
import path from "path";
import { createCompany, prisma, FIXTURES } from "./helpers.js";
import { matchInvoice } from "../../src/services/certificates/matching/productMatcher.js";

export const GOLDEN = JSON.parse(fs.readFileSync(path.join(FIXTURES, "matching", "goldens.json"), "utf8"));
const FAKE_FILE = "00000000-0000-4000-8000-0000000000a3";

/** → { company, foreign, products: { name → row }, foreignIds: Set } */
export async function seedMatchingCompanies(label = "a3match") {
  const company = await createCompany(label);
  const foreign = await createCompany(`${label}x`);
  const products = {};
  for (const p of GOLDEN.catalogue) products[p.name] = await prisma.product.create({ data: { ...p, companyId: company.id } });
  const foreignIds = new Set();
  for (const p of GOLDEN.foreign) foreignIds.add((await prisma.product.create({ data: { ...p, companyId: foreign.id } })).id);
  return { company, foreign, products, foreignIds };
}

export async function loadInvoice(companyId, idx) {
  const inv = await prisma.invoice.create({ data: { companyId, status: "review", sourceFileId: FAKE_FILE, header: { invoiceNumber: `M-${idx + 1}` }, headerExtracted: {} } });
  for (const [i, l] of GOLDEN.invoices[idx].lines.entries()) {
    const data = { code: null, extra: {}, ...l.data };
    await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: i + 1, data, dataExtracted: data } });
  }
  return inv;
}

/**
 * items after matching + expectations → { total, correct, wrong, leftCorrectly, suggestedCorrect, crossTenant, perLine[] }
 *   correct — matched to the expected product, or (expect null) left for the user;
 *             an AI suggestion of the right product waiting for confirmation counts as correct too
 *   wrong   — matched (or suggested) to another product, or matched although it should be left
 */
export function scoreMatching(items, idx, seed) {
  const lines = GOLDEN.invoices[idx].lines;
  const out = { total: lines.length, correct: 0, wrong: 0, leftCorrectly: 0, suggestedCorrect: 0, crossTenant: 0, perLine: [] };
  const nameOf = (id) => Object.values(seed.products).find((p) => p.id === id)?.name || null;
  for (const [i, l] of lines.entries()) {
    const it = items.find((x) => x.lineNo === i + 1);
    const cands = it.matchCandidates || [];
    if (cands.some((c) => seed.foreignIds.has(c.productId)) || seed.foreignIds.has(it.productId)) out.crossTenant++;
    const aiPick = cands.find((c) => c.ai)?.productId || null;
    const got = it.matchStatus === "matched" ? nameOf(it.productId) : null;
    const suggested = aiPick ? nameOf(aiPick) : null;
    let ok;
    if (l.expect === null) {
      ok = it.matchStatus === "needs_match" && !aiPick;
      if (ok) out.leftCorrectly++;
    } else if (got) ok = got === l.expect;
    else {
      ok = suggested === l.expect;
      if (ok) out.suggestedCorrect++;
    }
    if (ok) out.correct++;
    else out.wrong++;
    out.perLine.push({ lineNo: i + 1, name: l.data.name, expect: l.expect, got, method: it.matchMethod, suggested, aiConfidence: cands.find((c) => c.ai)?.ai?.confidence ?? null, ok });
  }
  return out;
}

/** A stand-in model that picks the expected product among each line's candidates (null when expected null). */
export function goldenMatchModel(idx, seed, { calls = [], override = null } = {}) {
  const lines = GOLDEN.invoices[idx].lines;
  return async (args) => {
    calls.push(args);
    const part = args.contents[args.contents.length - 1];
    const { lines: asked } = JSON.parse(part.slice(part.indexOf("\n") + 1));
    return {
      lines: asked.map((l) => {
        const o = override?.(l);
        if (o) return { lineNo: l.lineNo, ...o };
        const want = lines[l.lineNo - 1]?.expect;
        const hit = want ? l.candidates.find((c) => c.name === want) : null;
        return hit ? { lineNo: l.lineNo, productId: hit.id, confidence: 0.93, reasons: ["same product and pack size"] } : { lineNo: l.lineNo, productId: null, confidence: 0.4, reasons: ["no candidate is clearly the same product"] };
      }),
    };
  };
}

/** A person confirms every line as expected (the AI pick when it is the right one) and asks to remember
 *  each name — what makes aliases (owner, 2026-10-27: only an explicit "remember" teaches one). */
export async function confirmAsExpected(api, headers, invoiceId, idx, seed, { remember = true } = {}) {
  const items = await prisma.invoiceItem.findMany({ where: { invoiceId }, orderBy: { lineNo: "asc" } });
  for (const it of items) {
    const want = GOLDEN.invoices[idx].lines[it.lineNo - 1].expect;
    if (!want || (it.matchStatus === "matched" && it.productId === seed.products[want].id)) continue;
    const ai = (it.matchCandidates || []).find((c) => c.ai && c.productId === seed.products[want].id)?.ai;
    await api("PATCH", `/invoices/${invoiceId}/items/${it.id}`, headers, { productId: seed.products[want].id, ...(ai ? { aiSuggestionId: ai.suggestionId } : {}), ...(remember ? { rememberAlias: true } : {}) });
  }
}

export async function runMatching(seed, idx, { generate } = {}) {
  const inv = await loadInvoice(seed.company.id, idx);
  const res = await matchInvoice(inv.id, { generate });
  const items = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id }, orderBy: { lineNo: "asc" } });
  return { inv, res, items, score: scoreMatching(items, idx, seed) };
}
