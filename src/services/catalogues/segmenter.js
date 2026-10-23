// Catalogue → product blocks, by code (plan.md §15.3 step 2). No AI.
//  1. A spread page (landscape, two printed pages side by side) is split into
//     its halves; a portrait page is one region.
//  2. Inside a region, a large-font title (> TITLE_RATIO × the catalogue's body
//     size) starts a new product. Titles drawn as artwork have no text item, so
//     a half with no text title is still one block.
//  3. A part is a PRODUCT block when it has at least MIN_HEADINGS distinct
//     catalogue section headings (COMPOSITION, DOSAGE, PACKING, CODE, …); a part
//     without enough headings is merged into the next part (the "Liquid Oral
//     Solution" label above a title), and a region with none at all is a
//     CONTEXT block (cover, welcome, back page: producer and origin live there).
// The admin can merge or split blocks in the review screen.

export const SEGMENTER_VERSION = "a6.1-spread-title-headings";
const TITLE_RATIO = 3;
const MIN_HEADINGS = 2;
const SPREAD_RATIO = 1.3;

// Section headings seen in feed/veterinary catalogues. Matched on a line's first
// cell, upper-case only (a heading is never a sentence).
const HEADING_RE =
  /^(BENEFITS|COMPOSITION|DOSAGE(?: AND ADMINISTRATION)?|DOSE|WITHDRAWAL(?: TIMES?| PERIODS?)?|PRECAUTIONS|WARNINGS?|STORAGE(?: CONDITIONS?)?|PACKING|PACKAGING|PACK SIZES?|PRESENTATION|FORM|CODE|ACTIVE INGREDIENTS?|INGREDIENTS|SPECIFICATIONS?|INDICATIONS?|DESCRIPTION|HOW TO USE|DIRECTIONS(?: FOR USE)?|ADMINISTRATION|TARGET SPECIES|FUNCTIONS|EFFECTS(?: OF .+)?|CONTRAINDICATIONS?|SHELF LIFE|GUARANTEED ANALYSIS|ANALYSIS|APPLICATION(?: & DOSAGE)?)\s*[:!]?$/;

/** the heading names a line carries ("FORM\tCODE" → FORM, CODE) */
export function headingsOf(lineText) {
  const out = [];
  for (const cell of lineText.split("\t")) {
    const c = cell.trim();
    if (c && c === c.toUpperCase() && HEADING_RE.test(c)) out.push(c.replace(/\s*[:!]$/, ""));
  }
  return out;
}

/** The size most characters are set in (the body text), over the whole catalogue. */
export function bodySize(pages) {
  const chars = new Map();
  for (const p of pages) for (const it of p.items) if (!it.r) chars.set(it.h, (chars.get(it.h) || 0) + it.s.length);
  let best = 0;
  let size = 0;
  for (const [h, n] of chars) if (n > best) [best, size] = [n, h];
  return size || 8;
}

/** Items (stream order) → lines: same baseline and moving right → one line, cells joined by a tab. */
export function toLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    const last = cur?.items[cur.items.length - 1];
    const sameLine = last && !it.r && !last.r && Math.abs(it.y + it.h - (last.y + last.h)) < Math.max(1.5, 0.25 * Math.min(it.h, last.h)) && it.x >= last.x + last.w - 1;
    if (sameLine) cur.items.push(it);
    else lines.push((cur = { items: [it] }));
  }
  return lines.map(({ items: its }) => {
    const x = Math.min(...its.map((i) => i.x));
    const y = Math.min(...its.map((i) => i.y));
    const r = Math.max(...its.map((i) => i.x + i.w));
    const b = Math.max(...its.map((i) => i.y + i.h));
    return { t: its.map((i) => i.s).join("\t"), x, y, w: round(r - x), h: round(b - y), size: Math.max(0, ...its.filter((i) => !i.r).map((i) => i.h)) }; // rotated text is never a title
  });
}

function regionsOf(page) {
  if (page.width <= page.height * SPREAD_RATIO) return [{ items: page.items }];
  const mid = page.width / 2;
  const halves = [{ items: [] }, { items: [] }];
  for (const it of page.items) halves[it.x + it.w / 2 >= mid ? 1 : 0].items.push(it);
  return halves;
}

const distinctHeadings = (lines) => new Set(lines.flatMap((l) => headingsOf(l.t))).size;

function splitByTitles(lines, titleSize) {
  const parts = [];
  let cur = [];
  for (const l of lines) {
    if (l.size > titleSize && cur.some((c) => c.size > titleSize)) {
      parts.push(cur);
      cur = [];
    }
    cur.push(l);
  }
  if (cur.length) parts.push(cur);
  // a part without enough headings is not a product on its own: merge it forward (or back, when last)
  const merged = [];
  let carry = [];
  for (const p of parts) {
    const withCarry = [...carry, ...p];
    if (distinctHeadings(withCarry) >= MIN_HEADINGS) {
      merged.push(withCarry);
      carry = [];
    } else carry = withCarry;
  }
  if (carry.length) {
    if (merged.length) merged[merged.length - 1].push(...carry);
    else merged.push(carry);
  }
  return merged;
}

/** One block: text = lines joined by "\n", each line keeps its offset into the text and its box. */
function makeBlock(page, lines, kind, titleSize) {
  let o = 0;
  const out = lines.map((l) => {
    const line = { t: l.t, o, x: l.x, y: l.y, w: l.w, h: l.h };
    o += l.t.length + 1;
    return line;
  });
  const x = Math.min(...lines.map((l) => l.x));
  const y = Math.min(...lines.map((l) => l.y));
  const r = Math.max(...lines.map((l) => l.x + l.w));
  const b = Math.max(...lines.map((l) => l.y + l.h));
  const titleLine = kind === "product" ? lines.find((l) => l.size > titleSize) : null;
  return {
    kind,
    page: page.n,
    bbox: { x, y, w: round(r - x), h: round(b - y) },
    title: titleLine ? titleLine.t.replace(/\t/g, " ") : null,
    text: lines.map((l) => l.t).join("\n"),
    lines: out,
  };
}

/**
 * layout ({ pages } from readPdfLayout) → { blocks: [{ seq, kind, page, bbox, title, text, lines }], warnings, stats }
 */
export function segment(layout) {
  const pages = layout.pages || [];
  const body = bodySize(pages);
  const titleSize = body * TITLE_RATIO;
  const blocks = [];
  const warnings = [];
  for (const page of pages) {
    if (!page.items.length) {
      warnings.push({ code: "no_text_layer", page: page.n, message: `Page ${page.n} has no text layer (scanned?) — nothing on it can be verified; OCR is out of scope.` });
      continue;
    }
    for (const region of regionsOf(page)) {
      if (!region.items.length) continue;
      const lines = toLines(region.items);
      if (distinctHeadings(lines) < MIN_HEADINGS) {
        blocks.push(makeBlock(page, lines, "context", titleSize));
        continue;
      }
      for (const part of splitByTitles(lines, titleSize)) blocks.push(makeBlock(page, part, distinctHeadings(part) >= MIN_HEADINGS ? "product" : "context", titleSize));
    }
  }
  if (!blocks.some((b) => b.kind === "product")) warnings.push({ code: "no_product_blocks", message: "No product block was found — check the file is a product catalogue with live text." });
  blocks.forEach((b, i) => (b.seq = i));
  return { blocks, warnings, stats: { pages: pages.length, bodySize: body, products: blocks.filter((b) => b.kind === "product").length, context: blocks.filter((b) => b.kind === "context").length } };
}

const round = (v) => Math.round(v * 10) / 10;
