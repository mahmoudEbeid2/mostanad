// Phase 2 (28 Nov): a client's certificate PDF holds many pages of the SAME design (the ADDVET COC: 10
// pages, one per product). Comparing them says what is a field and what is the design, without AI:
//   text that changes between pages at the same place  → a field (variable)
//   text identical on every page                       → the design (static — marked so automatically)
// plus "{{placeholder}}" text, and text on an Illustrator / PDF layer named "Variables".
// Positioned text comes from pdf.js (no Python sidecar needed: its runs carry their position).
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { prisma } from "../../../lib/prisma.js";
import * as fileStore from "../storage/fileStore.js";

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const PLACEHOLDER = /\{\{[^{}]{1,60}\}\}/;

/** A PDF → its pages' positioned lines: [{ page, width, height, lines: [{ text, x, y, layer? }] }] */
export async function positionedPages(buffer, { maxPages = 40 } = {}) {
  const doc = await getDocument({ data: new Uint8Array(buffer), disableFontFace: true, useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    let oc = null;
    try {
      oc = await doc.getOptionalContentConfig();
    } catch {
      oc = null;
    }
    const out = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ includeMarkedContent: true });
      const runs = [];
      const layers = [];
      for (const it of content.items) {
        if (it.type === "beginMarkedContentProps" || it.type === "beginMarkedContent") {
          let name = null;
          if (it.tag === "OC" && it.id && oc) {
            try {
              name = oc.getGroup(it.id)?.name || null;
            } catch {
              name = null;
            }
          }
          layers.push(name);
          continue;
        }
        if (it.type === "endMarkedContent") {
          layers.pop();
          continue;
        }
        if (typeof it.str !== "string" || !it.str.trim()) continue;
        const layer = [...layers].reverse().find(Boolean) || null;
        runs.push({ text: it.str, x: it.transform[4], y: vp.height - it.transform[5], w: it.width || 0, layer });
      }
      // runs on one baseline (±2 pt) → a line, left to right; a wide gap starts another line (a column)
      runs.sort((a, b) => a.y - b.y || a.x - b.x);
      const lines = [];
      for (const r of runs) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.y - r.y) <= 2 && r.x - (last.x + last.w) < 25) {
          last.text += (r.x - (last.x + last.w) > 1.5 ? " " : "") + r.text;
          last.w = r.x + r.w - last.x;
          last.layer ||= r.layer;
        } else lines.push({ text: r.text, x: r.x, y: r.y, w: r.w, layer: r.layer });
      }
      out.push({ page: n, width: vp.width, height: vp.height, lines: lines.map((l) => ({ ...l, text: norm(l.text) })).filter((l) => l.text) });
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

/**
 * The reference page's lines, each "static" (same text, same place, on every other page) or "variable"
 * (it changes, or a placeholder / Variables-layer text). Pages of another design (few lines in common) are
 * left out. → { pagesCompared, lines: [{ text, x, y, status, why }] }
 */
export function diffPages(pages, refPage = 1) {
  const ref = pages.find((p) => p.page === refPage) || pages[0];
  if (!ref) return { pagesCompared: 0, lines: [] };
  const at = (p, l) => p.lines.find((m) => Math.abs(m.y - l.y) <= 3 && Math.abs(m.x - l.x) <= 4);
  // the same design: at least 40 % of the reference lines have a counterpart in place
  const others = pages.filter((p) => p !== ref && ref.lines.filter((l) => at(p, l)).length >= ref.lines.length * 0.4);
  const lines = ref.lines.map((l) => {
    if (PLACEHOLDER.test(l.text)) return { ...l, status: "variable", why: "placeholder" };
    if (l.layer && /^variables?$/i.test(l.layer)) return { ...l, status: "variable", why: "layer" };
    if (!others.length) return { ...l, status: "unknown", why: "one page" };
    const twins = others.map((p) => at(p, l));
    if (twins.every((t) => t && t.text === l.text)) return { ...l, status: "static", why: `same on ${others.length + 1} pages` };
    // moved, not changed: a table above it is longer on another page — the same text is still on every page
    if (twins.some((t) => !t) && others.every((p) => p.lines.some((m) => m.text === l.text))) return { ...l, status: "static", why: `same text on ${others.length + 1} pages (moved)` };
    return { ...l, status: "variable", why: "changes between pages" };
  });
  return { pagesCompared: others.length + 1, lines };
}

/** A version's line (converted HTML) ↔ the diff's line: same text (the first unused one, in reading order) */
function matchLines(versionLines, diffLines) {
  const used = new Set();
  const out = new Map();
  for (const vl of [...versionLines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
    const t = norm(vl.text);
    if (!t) continue;
    const i = diffLines.findIndex((d, k) => !used.has(k) && (d.text === t || (t.length > 6 && (d.text.includes(t) || t.includes(d.text)))));
    if (i >= 0) {
      used.add(i);
      out.set(vl.id, diffLines[i]);
    }
  }
  return out;
}

/**
 * Compare the pages of the file a version was made from and apply it:
 *   - every place readiness asks about whose line is the same on every page → marked static (by "page_diff")
 *   - lines that change between pages that no rule found → returned as extra open places (made fields)
 * fileId: the multi-page file; page: the file's page the version shows. → { pagesCompared, static, extra: [area] }
 */
export async function applyPageDiff(versionId, { fileId, page = 1 }) {
  const v = await prisma.templateVersion.findUnique({ where: { id: versionId }, select: { id: true, lines: true, staticAreas: true } });
  if (!v || !fileId) return { pagesCompared: 0, static: 0, extra: [] };
  let pages;
  try {
    pages = await positionedPages((await fileStore.readFile(fileId)).buffer);
  } catch {
    return { pagesCompared: 0, static: 0, extra: [] };
  }
  const diff = diffPages(pages, page);
  if (diff.pagesCompared < 2 && !diff.lines.some((l) => l.status === "variable")) return { pagesCompared: diff.pagesCompared, static: 0, extra: [] };
  const lines = v.lines || [];
  const byLine = matchLines(lines, diff.lines);
  const { getReadiness } = await import("./readinessService.js");
  const { areaId } = await import("./readinessCheck.js");
  const r = await getReadiness(versionId);
  const fields = await prisma.templateField.findMany({ where: { versionId }, select: { lineId: true } });
  const marked = new Set(fields.map((f) => f.lineId));
  // static: the readiness places on lines identical across the pages (a person can take it back)
  const already = new Set((v.staticAreas || []).map((a) => a.id));
  // only a place with no known meaning: a batch fact, date, basis or quantity is never "static", nor a
  // labelled product value (it comes from the product record — Phase 3), even when one company prints it alike
  const generic = (a) => !["batch", "date", "basis", "quantity"].includes(a.kind) && (!a.label || /^(Product data|Analysis result|Value)$/.test(a.label));
  const toStatic = r.areas.filter((a) => !a.staticConfirmed && !already.has(a.id) && generic(a) && byLine.get(a.lineId)?.status === "static");
  if (toStatic.length) {
    const list = [...(v.staticAreas || []), ...toStatic.map((a) => ({ id: a.id, text: a.text, kind: a.kind, byUserId: null, by: "page_diff", why: byLine.get(a.lineId).why, at: new Date().toISOString() }))];
    await prisma.templateVersion.update({ where: { id: versionId }, data: { staticAreas: list } });
  }
  // variable lines nothing covers yet: a field each (the whole line, its label read from the row by autoMap)
  const covered = new Set(r.areas.map((a) => a.lineId));
  const extra = lines
    // (a sentence is never a value: a long line that wraps differently on another page isn't a field — prod COA, 28 Nov)
    .filter((l) => byLine.get(l.id)?.status === "variable" && !covered.has(l.id) && !marked.has(l.id) && !/:\s*$/.test(l.text) && l.text.trim().split(/\s+/).length <= 8)
    .map((l) => {
      const s = l.text.length - l.text.trimStart().length;
      const e = l.text.trimEnd().length;
      return { id: areaId(l.id, s, e), lineId: l.id, page: l.page, charStart: s, charEnd: e, text: l.text.slice(s, e), kind: "value", label: "Product data", why: byLine.get(l.id).why };
    });
  return { pagesCompared: diff.pagesCompared, static: toStatic.length, extra };
}
