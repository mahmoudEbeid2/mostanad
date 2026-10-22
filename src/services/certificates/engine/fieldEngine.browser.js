/*
 * THE certificate field engine (CERTIFICATES_V2_PLAN.md §7). Runs INSIDE a
 * Puppeteer page — never in Node, never in the frontend (plan D11). Plain JS,
 * no imports; the renderer injects it with page.evaluate(source).
 *
 * Ported from the 2026-10-08 spike (ai2html-test/public/index.html:
 * makeField → clear, applyLayout → layout, cleanHTML → serialize).
 *
 * Every geometry value is CSS px relative to its page element ([data-page]),
 * so it does not depend on zoom or scroll. Values only ever go through
 * textContent (§7.7) — no innerHTML is written anywhere in this file.
 */
(function () {
  "use strict";
  if (window.__certEngine) return;

  const ENGINE_ATTR = "data-engine";
  const TOL = 0.5; // px — calibration / round-trip / overflow tolerance (§7.6)

  const round = (n) => Math.round(n * 1000) / 1000;
  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));

  function pageEls() {
    return Array.from(document.querySelectorAll("[data-page]")).sort(
      (a, b) => Number(a.getAttribute("data-page")) - Number(b.getAttribute("data-page"))
    );
  }
  const pageOf = (el) => (el.nodeType === 1 ? el : el.parentElement).closest("[data-page]");
  const pageNo = (pageEl) => Number(pageEl.getAttribute("data-page")) || 1;

  function relRect(rect, pageEl) {
    const pr = pageEl.getBoundingClientRect();
    return { x: round(rect.left - pr.left), y: round(rect.top - pr.top), w: round(rect.width), h: round(rect.height) };
  }

  function textNodes(el) {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) out.push(w.currentNode);
    return out;
  }

  const lineEl = (lineId) => document.querySelector(`[data-line="${cssEscape(lineId)}"]`);

  // Range over [start, end) code-unit offsets of the line's textContent.
  function rangeFromOffsets(line, start, end) {
    const r = document.createRange();
    let pos = 0;
    let started = false;
    for (const n of textNodes(line)) {
      const len = n.data.length;
      if (!started && start < pos + len) {
        r.setStart(n, start - pos);
        started = true;
      }
      if (started && end <= pos + len) {
        r.setEnd(n, end - pos);
        return r;
      }
      pos += len;
    }
    return null;
  }

  function fontClassOf(node, stopAt) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el) {
      for (const c of el.classList) if (/^ff[0-9a-z]+$/i.test(c)) return c;
      if (el === stopAt) break;
      el = el.parentElement;
    }
    return null;
  }

  function isTransparentColor(color) {
    if (!color) return false;
    if (color === "transparent") return true;
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(/[,\s/]+/).filter(Boolean);
    return parts.length === 4 && Number(parts[3]) === 0;
  }

  // true when the span sits in a transparent spacer (P1) or renders invisibly
  function inTransparent(span, line) {
    let el = span;
    while (el && el !== line.parentElement) {
      if (el !== span && el.classList && el.classList.contains("_")) return true;
      if (isTransparentColor(getComputedStyle(el).color)) return true;
      if (el === line) break;
      el = el.parentElement;
    }
    return false;
  }

  // Screen px per CSS px at `el` (inside a transformed pdf2htmlEX line).
  // Measured with a 1000 px probe: offsetWidth is rounded to whole px, which
  // made the margin compensation drift by ~0.1–0.2 % of the growth (0.7 px on
  // a 60-character value).
  function scaleOf(el) {
    const probe = document.createElement("span");
    probe.setAttribute(ENGINE_ATTR, "probe");
    probe.style.cssText = "display:inline-block;width:1000px;height:0;margin:0;padding:0;border:0;font-size:0";
    el.appendChild(probe);
    const s = probe.getBoundingClientRect().width / 1000;
    probe.remove();
    return s > 0 ? s : 1;
  }

  // ── analyse (§7.2) ──────────────────────────────────────────────────────────
  function analyse() {
    const pages = pageEls().map((p) => {
      const r = p.getBoundingClientRect();
      return { page: pageNo(p), widthPx: round(r.width), heightPx: round(r.height) };
    });
    const lines = Array.from(document.querySelectorAll("[data-line]")).map((el) => {
      const pageEl = pageOf(el);
      const r = document.createRange();
      r.selectNodeContents(el);
      return {
        id: el.getAttribute("data-line"),
        page: pageEl ? pageNo(pageEl) : 1,
        text: el.textContent,
        box: pageEl ? relRect(r.getBoundingClientRect(), pageEl) : null,
        fontClass: fontClassOf(el, el),
      };
    });
    return { pages, lines };
  }

  // Non-pdf2htmlEX .html upload (§8.1): body is page 1, every element whose own
  // text is non-empty is a line.
  function markGenericLines() {
    if (document.querySelector("[data-page]")) return { marked: false };
    document.body.setAttribute("data-page", "1");
    let i = 0;
    for (const el of document.body.querySelectorAll("*")) {
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.data.trim());
      if (own && !el.closest("[data-line]")) el.setAttribute("data-line", `p1-l${++i}`);
    }
    return { marked: true, lines: i };
  }

  // ── layout pass for one span (§7.4 steps 1–4) ───────────────────────────────
  // Keeps the rest of the line fixed whatever the value's length, and anchors
  // the value left / center / right inside its original box (P4/P5).
  function anchor(span, def) {
    span.style.marginLeft = "0px";
    span.style.marginRight = "0px";
    const w = span.textContent ? span.getBoundingClientRect().width : 0;
    const d = (w - def.box.w) / def.scale; // growth in CSS px
    const ml = def.align === "right" ? -d : def.align === "center" ? -d / 2 : 0;
    span.style.marginLeft = `${ml.toFixed(4)}px`;
    span.style.marginRight = `${(-d - ml).toFixed(4)}px`;
  }

  function extentOf(span, pageEl) {
    const r = relRect(span.getBoundingClientRect(), pageEl);
    return { x0: r.x, x1: round(r.x + r.w) };
  }

  function fits(ext, limits) {
    return ext.x0 >= limits.minX - TOL && ext.x1 <= limits.maxX + TOL;
  }

  function layoutField(span, def) {
    const pageEl = pageOf(span);
    span.style.fontSize = "";
    anchor(span, def);
    const flags = [];
    let fontScale = 1;
    if (span.textContent && def.limits && !fits(extentOf(span, pageEl), def.limits)) {
      const base = parseFloat(getComputedStyle(span).fontSize);
      let fitted = false;
      for (let f = 0.98; f >= 0.8 - 1e-9; f -= 0.02) {
        span.style.fontSize = `${(base * f).toFixed(4)}px`;
        anchor(span, def);
        fontScale = round(f);
        if (fits(extentOf(span, pageEl), def.limits)) {
          fitted = true;
          break;
        }
      }
      if (fitted) flags.push("shrunk");
      else {
        span.style.fontSize = `${(base * 0.8).toFixed(4)}px`;
        anchor(span, def);
        fontScale = 0.8;
        flags.push("overflow");
      }
    }
    return { flags, fontScale, extent: extentOf(span, pageEl) };
  }

  // ── text runs, for limits (§7.3 step 6) ─────────────────────────────────────
  function visibleRuns(pageEl, excludeEl) {
    const runs = [];
    for (const n of textNodes(pageEl)) {
      if (!n.data.trim()) continue;
      if (excludeEl && excludeEl.contains(n)) continue;
      const host = n.parentElement;
      const cs = getComputedStyle(host);
      if (cs.visibility === "hidden" || cs.display === "none" || isTransparentColor(cs.color)) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const rect of r.getClientRects()) {
        if (rect.width < 0.01 || rect.height < 0.01) continue;
        runs.push({ node: n, rect: relRect(rect, pageEl) });
      }
    }
    return runs;
  }

  // The design's text margins: left-most / right-most visible text on the
  // page (field samples included). Owner decision 2026-10-17 (plan §20 I10):
  // a value with no neighbour on its baseline may grow up to the printed
  // area, not to the physical page edge.
  function textMargins(runs, pageWidth) {
    if (!runs.length) return { left: 0, right: pageWidth };
    return { left: Math.min(...runs.map((r) => r.rect.x)), right: Math.max(...runs.map((r) => r.rect.x + r.rect.w)) };
  }

  function limitsFor(box, runs, margins) {
    const baseline = box.y + box.h * 0.8;
    let minX = Math.min(margins.left, box.x);
    let maxX = Math.max(margins.right, box.x + box.w);
    for (const { rect } of runs) {
      if (!(rect.y <= baseline && baseline <= rect.y + rect.h)) continue;
      const right = rect.x + rect.w;
      if (right <= box.x + TOL) minX = Math.max(minX, right);
      else if (rect.x >= box.x + box.w - TOL) maxX = Math.min(maxX, rect.x);
    }
    return { minX: round(minX), maxX: round(maxX) };
  }

  // ── inspect: measure field ranges WITHOUT changing the document ─────────────
  // Used while fields are being marked (§8.2, §13.4): validates the offsets in
  // the real layout and computes the "suggest center" heuristic on the server
  // (D11): a value is suggested `center` when its center matches the center
  // of the text segment right above it (its column header) and it is NOT
  // simply left/right-aligned with it. Tolerance: max(2 px, 10 % of the header
  // width) — measured on PHARMAVET, whose centered cells sit 2.9–5.5 px off
  // their header's exact center (plan §20 I7).
  // fields: [{ key, lineId, charStart, charEnd, sampleValue }]
  const SUGGEST_CENTER_PX = 2;
  const SUGGEST_CENTER_REL = 0.1;
  const EDGE_ALIGNED_PX = 1; // stacked left-aligned values share their x exactly

  // visible runs of one row merged into segments (kerning spans split a word
  // into many text nodes; a column gap is much wider than a word space)
  function segmentsOf(runs) {
    const sorted = runs.slice().sort((a, b) => a.rect.x - b.rect.x);
    const out = [];
    for (const { rect } of sorted) {
      const last = out[out.length - 1];
      const gap = last ? rect.x - last.x1 : Infinity;
      if (last && gap <= Math.max(4, rect.h * 0.8)) last.x1 = Math.max(last.x1, rect.x + rect.w);
      else out.push({ x0: rect.x, x1: rect.x + rect.w });
    }
    return out;
  }

  function headerAbove(box, runs) {
    const above = runs.filter(
      ({ rect }) => rect.y + rect.h <= box.y + TOL && rect.x < box.x + box.w && rect.x + rect.w > box.x && box.y - (rect.y + rect.h) < 80
    );
    if (!above.length) return null;
    const bottom = Math.max(...above.map(({ rect }) => rect.y + rect.h));
    const row = runs.filter(({ rect }) => Math.abs(rect.y + rect.h - bottom) <= 1.5);
    const seg = segmentsOf(row).find((s) => s.x0 < box.x + box.w && s.x1 > box.x);
    return seg ? { x0: round(seg.x0), x1: round(seg.x1), center: round((seg.x0 + seg.x1) / 2) } : null;
  }

  // ── label context (AI plan §5.1 step 2): what is printed around a value ────
  // Read-only. columnHeader: the nearest text above in the value's column
  // that is printed in a DIFFERENT font than the value (headers are styled;
  // the values stacked between header and value are not). rowCells: the
  // row's cells left → right; rowIndex: the value's cell.
  const HEADER_MAX_DISTANCE = 200; // px above the value
  const HEADER_MAX_ROW_GAP = 45; // a larger gap ends the column (another block)

  function fontKey(el) {
    const cs = getComputedStyle(el);
    return [cs.fontFamily, cs.fontWeight, cs.fontStyle, Math.round(parseFloat(cs.fontSize) * 10) / 10, cs.color].join("|");
  }

  // the text of `rowRuns` between x0 and x1, in visual order. Designs split
  // words into many kerning spans, so spaces come from the printed spaces and
  // from real gaps (> 0.3 × the glyph height) — never from span boundaries.
  function textBetween(rowRuns, x0, x1) {
    const seen = new Set();
    const chars = [];
    for (const run of rowRuns) {
      if (seen.has(run.node)) continue;
      seen.add(run.node);
      const pageEl = pageOf(run.node.parentElement);
      for (let i = 0; i < run.node.data.length; i++) {
        const r = document.createRange();
        r.setStart(run.node, i);
        r.setEnd(run.node, i + 1);
        const rect = relRect(r.getBoundingClientRect(), pageEl);
        const cx = rect.x + rect.w / 2;
        if (cx < x0 - 0.5 || cx > x1 + 0.5) continue;
        chars.push({ c: run.node.data[i], x: rect.x, r: rect.x + rect.w, h: rect.h });
      }
    }
    chars.sort((a, b) => a.x - b.x);
    let out = "";
    let prev = null;
    let space = false;
    for (const ch of chars) {
      if (/\s/.test(ch.c)) {
        space = true;
        continue;
      }
      if (prev && (space || ch.x - prev.r > Math.max(1, prev.h * 0.3))) out += " ";
      out += ch.c;
      prev = ch;
      space = false;
    }
    return out.trim();
  }

  function rowsOf(runs) {
    const rows = [];
    for (const run of runs.slice().sort((a, b) => b.rect.y + b.rect.h - (a.rect.y + a.rect.h))) {
      const bottom = run.rect.y + run.rect.h;
      const row = rows.find((r) => Math.abs(r.bottom - bottom) <= 1.5);
      if (row) row.runs.push(run);
      else rows.push({ bottom, runs: [run] });
    }
    return rows;
  }

  function labelContext(box, runs, valueEl) {
    const valueFont = fontKey(valueEl);
    const mid = box.y + box.h / 2;
    const rowRuns = runs.filter(({ rect }) => rect.y <= mid && mid <= rect.y + rect.h);
    const cells = segmentsOf(rowRuns);
    const rowCells = cells.map((s) => textBetween(rowRuns, s.x0, s.x1));
    const centre = box.x + box.w / 2;
    const rowIndex = cells.findIndex((s) => s.x0 - TOL <= centre && centre <= s.x1 + TOL);

    let columnHeader = null;
    let prevTop = box.y;
    for (const row of rowsOf(runs.filter(({ rect }) => rect.y + rect.h <= box.y + TOL && box.y - (rect.y + rect.h) <= HEADER_MAX_DISTANCE))) {
      const top = Math.min(...row.runs.map((r) => r.rect.y));
      if (prevTop - row.bottom > HEADER_MAX_ROW_GAP) break;
      prevTop = top;
      const segs = segmentsOf(row.runs).map((s) => ({ ...s, overlap: Math.min(s.x1, box.x + box.w) - Math.max(s.x0, box.x) })).filter((s) => s.overlap > 0);
      if (!segs.length) continue; // an empty cell of this column
      const seg = segs.sort((a, b) => b.overlap - a.overlap)[0];
      const inSeg = row.runs.filter(({ rect }) => rect.x < seg.x1 && rect.x + rect.w > seg.x0);
      if (inSeg.some((r) => fontKey(r.node.parentElement) !== valueFont)) {
        columnHeader = textBetween(inSeg, seg.x0, seg.x1);
        break;
      }
    }
    return { columnHeader: columnHeader || null, rowCells, rowIndex };
  }

  function inspect(fields) {
    const out = {};
    const runsByPage = new Map();
    for (const f of fields) {
      const line = lineEl(f.lineId);
      if (!line) {
        out[f.key] = { ok: false, error: "LINE_NOT_FOUND" };
        continue;
      }
      const range = rangeFromOffsets(line, f.charStart, f.charEnd);
      if (!range || range.toString() !== f.sampleValue) {
        out[f.key] = { ok: false, error: "OFFSET_MISMATCH", found: range ? range.toString() : null };
        continue;
      }
      const pageEl = pageOf(line);
      const box = relRect(range.getBoundingClientRect(), pageEl);
      if (!runsByPage.has(pageEl)) runsByPage.set(pageEl, visibleRuns(pageEl, null));
      const header = headerAbove(box, runsByPage.get(pageEl));
      let suggestedAlign = "left";
      if (header) {
        const tol = Math.max(SUGGEST_CENTER_PX, (header.x1 - header.x0) * SUGGEST_CENTER_REL);
        const centered = Math.abs(header.center - (box.x + box.w / 2)) <= tol;
        const edgeAligned = Math.abs(header.x0 - box.x) <= EDGE_ALIGNED_PX || Math.abs(header.x1 - (box.x + box.w)) <= EDGE_ALIGNED_PX;
        if (centered && !edgeAligned) suggestedAlign = "center";
      }
      const valueEl = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
      out[f.key] = { ok: true, page: pageNo(pageEl), box, header, suggestedAlign, labelContext: labelContext(box, runsByPage.get(pageEl), valueEl) };
    }
    return out;
  }

  // ── clear (§7.3) ─────────────────────────────────────────────────────────────
  // fields: [{ key, lineId, charStart, charEnd, sampleValue, align }]
  // → { results: { [key]: { ok, error?, box, limits, letterSpacing, fontClass, scale, calibration, transparent } } }
  function clear(fields) {
    const results = {};
    const byLine = new Map();
    for (const f of fields) {
      if (!byLine.has(f.lineId)) byLine.set(f.lineId, []);
      byLine.get(f.lineId).push(f);
    }

    const placed = [];
    for (const [lineId, list] of byLine) {
      const line = lineEl(lineId);
      // right-to-left so earlier offsets stay valid
      list.sort((a, b) => b.charStart - a.charStart);
      for (const f of list) {
        if (!line) {
          results[f.key] = { ok: false, error: "LINE_NOT_FOUND" };
          continue;
        }
        const pageEl = pageOf(line);
        const range = rangeFromOffsets(line, f.charStart, f.charEnd);
        if (!range || range.toString() !== f.sampleValue) {
          results[f.key] = {
            ok: false,
            error: "OFFSET_MISMATCH",
            found: range ? range.toString() : null,
          };
          continue;
        }
        const before = relRect(range.getBoundingClientRect(), pageEl);

        range.deleteContents();
        const span = document.createElement("span");
        span.setAttribute("data-field", f.key);
        span.style.wordSpacing = "0px"; // P3
        span.style.letterSpacing = "0px";
        span.textContent = f.sampleValue;
        range.insertNode(span);
        // P1 — never leave the field inside a transparent spacer span
        let p = span.parentElement;
        while (p && p !== line) {
          if (p.classList.contains("_")) {
            p.after(span);
            p = span.parentElement;
            continue;
          }
          p = p.parentElement;
        }

        // P2 — calibrate by measurement
        const scale = scaleOf(span);
        const n = Array.from(f.sampleValue).length;
        const w0 = span.getBoundingClientRect().width;
        const ls = scale > 0 && n > 0 ? (before.w - w0) / scale / n : 0;
        span.style.letterSpacing = `${ls.toFixed(4)}px`;
        const after = relRect(span.getBoundingClientRect(), pageEl);

        results[f.key] = {
          ok: true,
          box: before,
          letterSpacing: round(ls),
          fontClass: fontClassOf(span, line),
          scale: Math.round(scale * 1e9) / 1e9, // full precision — it multiplies every margin
          calibration: { dx: round(Math.abs(after.x - before.x)), dw: round(Math.abs(after.w - before.w)) },
          transparent: inTransparent(span, line),
        };
        placed.push({ f, span, pageEl });
      }
    }

    // limits need every field in place (with its sample text) as neighbours
    const runsByPage = new Map();
    for (const { f, span, pageEl } of placed) {
      if (!runsByPage.has(pageEl)) {
        const all = visibleRuns(pageEl, null);
        runsByPage.set(pageEl, { all, margins: textMargins(all, pageEl.getBoundingClientRect().width) });
      }
      const { all, margins } = runsByPage.get(pageEl);
      results[f.key].limits = limitsFor(results[f.key].box, all.filter((r) => !span.contains(r.node)), margins);
    }

    // empty every span; the empty-value layout reserves the original width so
    // neighbours never move even in the raw prepared file (§7.4 step 6)
    for (const { f, span } of placed) {
      span.textContent = "";
      span.removeAttribute("contenteditable");
      const r = results[f.key];
      anchor(span, { box: r.box, scale: r.scale, align: f.align || "left" });
    }
    return { results };
  }

  // ── SVG background (§7.8) ───────────────────────────────────────────────────
  // A template with a repeating group is converted with --bg-format svg: table
  // rules, logo, stamp and watermark are separate vector elements inside ONE
  // base64 <img> (never inlined — the SVG can't run script or fetch anything
  // from an <img>). The engine decodes it, edits it and re-encodes it.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SVG_PREFIX = "data:image/svg+xml;base64,";
  const EPS = 1; // px — "on the rule" tolerance for classification
  const THIN = 1.5; // px — a rule is thinner than this and longer than 3 px
  const FOOTER_GAP = 8; // px kept free above the footer line
  const MIN_FOOTER_GAP = 24; // px — smallest whitespace proposed as the footer break

  const svgImages = (pageEl) => Array.from(pageEl.querySelectorAll("img")).filter((i) => (i.getAttribute("src") || "").startsWith(SVG_PREFIX));
  const pageHasSvgBackground = (pageEl) => svgImages(pageEl).length > 0;

  function decodeSvg(img) {
    const bin = atob(img.getAttribute("src").slice(SVG_PREFIX.length));
    const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    return new DOMParser().parseFromString(text, "image/svg+xml");
  }

  async function encodeSvg(img, doc) {
    doc.documentElement.querySelectorAll("[data-eid]").forEach((el) => el.removeAttribute("data-eid"));
    const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(doc.documentElement));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    img.setAttribute("src", SVG_PREFIX + btoa(bin));
    await img.decode().catch(() => {});
  }

  const hrefOf = (el) => el.getAttribute("href") || el.getAttribute("xlink:href") || "";
  const urlRef = (doc, value) => {
    const m = String(value || "").match(/url\(\s*#([^)\s]+)\s*\)/);
    return m ? doc.getElementById(m[1]) : null;
  };

  // Convert-time normalisation of an SVG background (plan §20 I26):
  //  - defence in depth: no script/foreignObject, no on* handlers, only
  //    same-document (#id) or data:image references
  //  - cairo emulates a PDF blend mode with feImage/feBlend/feComposite
  //    filters over full-page masks. Chrome rasterises that filter at 1× and,
  //    in a printed PDF, leaves a hairline box around the blended raster
  //    (signature). Drawing the destination group, then the source group with
  //    the same `mix-blend-mode`, is the same composite natively.
  //  - cairo also expresses a constant alpha (a watermark at 10 %) as a
  //    luminance mask: one page-covering rect under a "remove color" filter.
  //    Chrome prints that as a soft mask some PDF viewers draw at full
  //    strength (pdf.js: a solid watermark); a plain `opacity` is the same
  //    thing and every viewer supports it.
  const WHITE_RGB = "0 0 0 0 1 0 0 0 0 1 0 0 0 0 1";
  function constantMaskAlpha(doc, mask, vbW, vbH) {
    const shapes = Array.from(mask.querySelectorAll("*")).filter((e) => !["g", "filter", "feColorMatrix"].includes(e.localName));
    if (shapes.length !== 1 || shapes[0].localName !== "rect") return null;
    const rect = shapes[0];
    const w = parseFloat(rect.getAttribute("width"));
    const h = parseFloat(rect.getAttribute("height"));
    if (!(w >= vbW && h >= vbH)) return null;
    // the luminance must be white: either the rect is white, or every wrapper filter maps RGB to 1
    let white = /^(#fff(fff)?|white|rgb\(100%,\s*100%,\s*100%\))$/i.test(rect.getAttribute("fill") || "");
    let alpha = Number(rect.getAttribute("fill-opacity") ?? 1) * Number(rect.getAttribute("opacity") ?? 1);
    for (let a = rect.parentElement; a && a !== mask; a = a.parentElement) {
      if (a.localName !== "g") return null;
      alpha *= Number(a.getAttribute("opacity") ?? 1);
      const f = a.getAttribute("filter");
      if (f) {
        const fe = urlRef(doc, f)?.querySelector("feColorMatrix");
        const v = (fe?.getAttribute("values") || "").trim().replace(/\s+/g, " ");
        if (!v.startsWith(WHITE_RGB) || !/ 0 0 0 1 0$/.test(v)) return null;
        white = true;
      }
    }
    return white && Number.isFinite(alpha) ? alpha : null;
  }

  // opts (diagnostics only): { blends: false } / { masks: false } skips that rewrite
  async function normalizeBackground(opts) {
    const o = { blends: true, masks: true, ...(opts || {}) };
    const out = { images: 0, blendsRewritten: 0, masksToOpacity: 0, removed: 0 };
    for (const img of Array.from(document.querySelectorAll("img")).filter((i) => (i.getAttribute("src") || "").startsWith(SVG_PREFIX))) {
      const doc = decodeSvg(img);
      const svg = doc.documentElement;
      if (svg.localName !== "svg") continue;
      out.images++;
      for (const el of Array.from(svg.querySelectorAll("script, foreignObject, iframe, object, embed, a"))) {
        el.remove();
        out.removed++;
      }
      for (const el of svg.querySelectorAll("*")) {
        for (const a of Array.from(el.attributes)) {
          if (/^on/i.test(a.name)) el.removeAttribute(a.name);
          else if (/(^|:)href$/i.test(a.name) && !/^\s*(#|data:image\/)/i.test(a.value)) el.removeAttribute(a.name);
        }
      }
      for (const top of o.blends ? Array.from(svg.children).filter((c) => c.localName === "g" && c.getAttribute("filter")) : []) {
        const f1 = urlRef(doc, top.getAttribute("filter"));
        const comp = f1 && f1.querySelector('feComposite[operator="arithmetic"]');
        const images1 = f1 ? Array.from(f1.querySelectorAll("feImage")) : [];
        if (!comp || images1.length !== 2 || comp.getAttribute("k2") !== "1" || comp.getAttribute("k3") !== "1" || Number(comp.getAttribute("k1") || 0) !== 0 || Number(comp.getAttribute("k4") || 0) !== 0) continue;
        const blended = doc.getElementById(hrefOf(images1[0]).slice(1));
        const f0 = blended && urlRef(doc, blended.getAttribute("filter"));
        const blend = f0 && f0.querySelector("feBlend");
        const images0 = f0 ? Array.from(f0.querySelectorAll("feImage")) : [];
        if (!blend || images0.length !== 2) continue;
        const src = doc.getElementById(hrefOf(images0[0]).slice(1));
        const dst = doc.getElementById(hrefOf(images0[1]).slice(1));
        if (!src || !dst) continue;
        const g = doc.createElementNS(SVG_NS, "g");
        if (top.getAttribute("transform")) g.setAttribute("transform", top.getAttribute("transform"));
        const u1 = doc.createElementNS(SVG_NS, "use");
        u1.setAttribute("href", `#${dst.id}`);
        const u2 = doc.createElementNS(SVG_NS, "use");
        u2.setAttribute("href", `#${src.id}`);
        u2.setAttribute("style", `mix-blend-mode:${blend.getAttribute("mode") || "normal"}`);
        g.append(u1, u2);
        top.replaceWith(g);
        out.blendsRewritten++;
      }
      const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
      const vbW = vb.length === 4 ? vb[2] : parseFloat(svg.getAttribute("width")) || 0;
      const vbH = vb.length === 4 ? vb[3] : parseFloat(svg.getAttribute("height")) || 0;
      for (const el of o.masks ? Array.from(svg.querySelectorAll("[mask]")) : []) {
        const mask = urlRef(doc, el.getAttribute("mask"));
        const alpha = mask ? constantMaskAlpha(doc, mask, vbW, vbH) : null;
        if (alpha === null) continue;
        el.removeAttribute("mask");
        if (alpha < 0.999) el.setAttribute("opacity", String(+(Number(el.getAttribute("opacity") ?? 1) * alpha).toFixed(6)));
        out.masksToOpacity++;
      }
      await encodeSvg(img, doc);
    }
    return out;
  }

  // A measurable model of one page's SVG background. Units are drawable
  // elements with their page-relative box (CSS px). A `use` of a <g> and a
  // plain <g> can be descended into; anything clipped/masked/filtered is one
  // unit (moving a child out of its clip would hide it).
  function openSvg(img, pageEl) {
    const doc = decodeSvg(img);
    const svg = doc.documentElement;
    let n = 0;
    for (const el of svg.querySelectorAll("*")) el.setAttribute("data-eid", String(++n));
    const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
    const vbW = vb.length === 4 && vb[2] ? vb[2] : parseFloat(svg.getAttribute("width")) || 1000;
    const vbH = vb.length === 4 && vb[3] ? vb[3] : parseFloat(svg.getAttribute("height")) || 1000;
    const host = document.createElement("div");
    host.setAttribute(ENGINE_ATTR, "svg-host");
    host.style.cssText = `position:absolute;left:0;top:0;width:${vbW}px;height:${vbH}px;visibility:hidden;pointer-events:none;overflow:visible`;
    document.body.appendChild(host);
    const live = document.importNode(svg, true);
    live.setAttribute("width", String(vbW));
    live.setAttribute("height", String(vbH));
    host.appendChild(live);
    const ir = relRect(img.getBoundingClientRect(), pageEl);
    const U = vbW / ir.w; // svg user units per CSS px
    const rootCTM = () => live.getScreenCTM();
    const docById = (eid) => svg.querySelector(`[data-eid="${eid}"]`);
    const asDom = (m) => new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]);
    const toRoot = (liveEl) => asDom(rootCTM()).inverse().multiply(asDom(liveEl.getScreenCTM()));
    const boxOf = (liveEl) => {
      const r = liveEl.getBoundingClientRect();
      const lr = live.getBoundingClientRect();
      return { x: round(ir.x + (r.left - lr.left) / U), y: round(ir.y + (r.top - lr.top) / U), w: round(r.width / U), h: round(r.height / U) };
    };
    const SKIP = new Set(["defs", "clipPath", "mask", "filter", "linearGradient", "radialGradient", "pattern", "symbol", "style", "title", "desc", "metadata", "marker"]);
    const isThin = (b) => Math.min(b.w, b.h) < THIN && Math.max(b.w, b.h) > 3;
    // A watermark is drawn at low opacity, directly or through a mask whose
    // strongest content is < 50 % (cairo also emits full-strength compositing
    // masks around blended groups — those are not watermarks)
    const opacityOf = (el) => Math.min(1, ...["opacity", "fill-opacity"].filter((a) => el.hasAttribute(a) && !(a === "fill-opacity" && el.getAttribute("fill") === "none")).map((a) => Number(el.getAttribute(a))));
    const maskStrength = (maskEl, depth = 0) => {
      if (!maskEl || depth > 4) return 1;
      let best = 0;
      for (const d of maskEl.querySelectorAll("rect, path, circle, ellipse, polygon, image, use")) {
        let o = opacityOf(d);
        for (let a = d.parentElement; a && a !== maskEl; a = a.parentElement) o *= opacityOf(a);
        if (d.localName === "use") {
          const ref = live.querySelector(`[id="${cssEscape(hrefOf(d).slice(1))}"]`);
          if (ref) o *= ref.localName === "g" || ref.localName === "mask" ? maskStrength(ref, depth + 1) : opacityOf(ref);
        }
        best = Math.max(best, o);
      }
      return best;
    };
    const refIn = (value) => {
      const id = (String(value || "").match(/#([^)\s]+)/) || [])[1];
      return id ? live.querySelector(`[id="${cssEscape(id)}"]`) : null;
    };
    const faintSelf = (el) => opacityOf(el) < 0.5 || (el.getAttribute("mask") ? maskStrength(refIn(el.getAttribute("mask"))) < 0.5 : false);
    const isFaint = (el) => faintSelf(el) || Array.from(el.querySelectorAll("[mask],[opacity],[fill-opacity]")).some(faintSelf);
    const mkUnit = (liveEl, parentLive) => {
      const b = boxOf(liveEl);
      const tag = liveEl.localName;
      const plain = !liveEl.getAttribute("clip-path") && !liveEl.getAttribute("mask") && !liveEl.getAttribute("filter") && !(liveEl.getAttribute("style") || "").includes("blend");
      const ref = tag === "use" ? live.querySelector(`[id="${cssEscape(hrefOf(liveEl).slice(1))}"]`) : null;
      return {
        eid: liveEl.getAttribute("data-eid"),
        live: liveEl,
        parentLive,
        box: b,
        tag,
        thin: isThin(b),
        vertical: isThin(b) && b.h > b.w,
        horizontal: isThin(b) && b.w >= b.h,
        stroked: !!liveEl.getAttribute("stroke") && liveEl.getAttribute("stroke") !== "none",
        subpaths: tag === "path" ? ((liveEl.getAttribute("d") || "").match(/[Mm]/g) || []).length : 0,
        image: tag === "image" || (ref && ref.localName === "image"),
        // a watermark: drawn through a mask or at low opacity — never moved
        faint: isFaint(liveEl) || (ref ? isFaint(ref) : false),
        faintSelf: faintSelf(liveEl) || (ref ? faintSelf(ref) : false),
        canDescend: (tag === "g" && plain && liveEl.children.length > 0) || (tag === "use" && ref && ref.localName === "g" && ref.children.length > 0),
      };
    };
    const childrenOf = (unit) => {
      if (unit.tag === "g") return Array.from(unit.live.children).filter((c) => !SKIP.has(c.localName)).map((c) => mkUnit(c, unit.live));
      // a <use> of a group: measure a copy of the group placed with the use's transform
      const ref = live.querySelector(`[id="${cssEscape(hrefOf(unit.live).slice(1))}"]`);
      const wrap = document.createElementNS(SVG_NS, "g");
      wrap.setAttribute(ENGINE_ATTR, "measure");
      const m = toRoot(unit.live);
      wrap.setAttribute("transform", `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`);
      const copy = ref.cloneNode(true);
      copy.removeAttribute("id");
      copy.removeAttribute("mask");
      copy.removeAttribute("filter");
      wrap.appendChild(copy);
      live.appendChild(wrap);
      // the copy carries the same data-eid values: edits go to the doc's group
      return Array.from(copy.children).filter((c) => !SKIP.has(c.localName)).map((c) => mkUnit(c, copy));
    };
    const topUnits = () => Array.from(live.children).filter((c) => !SKIP.has(c.localName) && !c.hasAttribute(ENGINE_ATTR)).map((c) => mkUnit(c, live));

    // edits in page px, expressed in the unit's parent coordinate system
    const parentMatrix = (unit) => (unit.parentLive === live ? new DOMMatrix() : toRoot(unit.parentLive));
    const wrapDoc = (unit, pageMatrix) => {
      const el = docById(unit.eid);
      if (!el) return null;
      const M = parentMatrix(unit);
      const t = M.inverse().multiply(pageMatrix).multiply(M);
      const g = doc.createElementNS(SVG_NS, "g");
      g.setAttribute("transform", `matrix(${t.a},${t.b},${t.c},${t.d},${t.e},${t.f})`);
      el.replaceWith(g);
      g.appendChild(el);
      return g;
    };
    const rootY = (pageY) => (pageY - ir.y) * U;
    // page-space matrices (root user units)
    const mShift = (dy) => new DOMMatrix().translate(0, dy * U);
    const mStretch = (unit, dy) => {
      // keep the top edge, grow (or shrink) the height by dy
      const h = unit.box.h;
      const k = h > 0 ? Math.max(0, (h + dy) / h) : 1;
      const y0 = rootY(unit.box.y);
      return new DOMMatrix().translate(0, y0).scale(1, k).translate(0, -y0);
    };
    const api = {
      img,
      U,
      pageH: relRect(pageEl.getBoundingClientRect(), pageEl).h,
      topUnits,
      childrenOf,
      mShift,
      mStretch,
      shift: (unit, dy) => (dy ? wrapDoc(unit, mShift(dy)) : null),
      stretch: (unit, dy) => (dy ? wrapDoc(unit, mStretch(unit, dy)) : null),
      // a copy drawn with `pageMatrix`, inserted right after the original —
      // ALWAYS call before transforming the original (which wraps it)
      clone(unit, pageMatrix) {
        const el = docById(unit.eid);
        if (!el) return null;
        const copy = el.cloneNode(true);
        copy.removeAttribute("data-eid");
        copy.querySelectorAll("[data-eid]").forEach((x) => x.removeAttribute("data-eid"));
        copy.removeAttribute("id");
        copy.querySelectorAll("[id]").forEach((x) => x.removeAttribute("id"));
        const M = parentMatrix(unit);
        const t = M.inverse().multiply(pageMatrix).multiply(M);
        const g = doc.createElementNS(SVG_NS, "g");
        g.setAttribute("transform", `matrix(${t.a},${t.b},${t.c},${t.d},${t.e},${t.f})`);
        g.appendChild(copy);
        el.after(g);
        return g;
      },
      remove(unit) {
        const el = docById(unit.eid);
        if (el) el.remove();
      },
      close() {
        host.remove();
      },
      async commit() {
        host.remove();
        await encodeSvg(img, doc);
      },
    };
    return api;
  }

  // Every unit of a page's SVG, descending into plain groups / uses of groups
  // when `descend(unit)` says so (default: everything that can be descended).
  function flatUnits(svgCtx, descend) {
    const out = [];
    const walk = (list) => {
      for (const u of list) {
        if (u.box.w === 0 && u.box.h === 0) continue;
        if (u.canDescend && (!descend || descend(u))) walk(svgCtx.childrenOf(u));
        else out.push(u);
      }
    };
    walk(svgCtx.topUnits());
    return out;
  }

  // One classification shared by detection and fill (§7.8). Categories:
  //  above   — ends at or above the band's top rule (untouched)
  //  faint   — watermark (mask / low opacity): never moved
  //  pinned  — starts below the footer line: never moved
  //  below   — between the band and the footer line: moves with the group
  //  band    — inside the band (row rules, cell fills, placeholder drawings)
  //  crosser — crosses the band (side band, page border): never touched
  //  margin  — entirely left/right of the table's frame (a vertical side
  //            band drawn letter by letter): never moved
  // A crossing group is only opened when it is a page-sized layer or covers
  // the table's columns; any other crossing group is kept whole.
  const overlapX = (b, t) => Math.max(0, Math.min(b.x + b.w, t.x1) - Math.max(b.x, t.x0));
  // inclusive: a perfectly vertical stroke has a zero-width box, and overlapX is 0 for it
  const spansX = (b, t) => b.x + b.w >= t.x0 && b.x <= t.x1;
  // strictly beside the frame (the table's own outer border sits ON its edge)
  const outsideFrame = (b, frame) => !!frame && (b.x + b.w < frame.x0 - THIN || b.x > frame.x1 + THIN);
  function classifyUnits(ctx, band, footerY, table, frame) {
    const { y0, y1 } = band;
    const within = (b) => b.y >= y0 - EPS && b.y + b.h <= y1 + EPS;
    const crosses = (b) => b.y < y1 - EPS && b.y + b.h > y0 + EPS && !within(b);
    const area = frame || table;
    // open layers (a <use> of a group — how cairo draws compositing layers — or
    // anything page-sized) unless the layer itself is faint, and crossing
    // groups over the table that hold no watermark
    const descend = (u) => crosses(u.box) && !u.faintSelf && (u.tag === "use" || u.box.h >= 0.9 * ctx.pageH || (!u.faint && spansX(u.box, area)));
    return flatUnits(ctx, descend).map((u) => {
      const top = u.box.y;
      const bottom = u.box.y + u.box.h;
      let cat;
      if (bottom <= y0 + EPS) cat = "above";
      else if (u.faint) cat = "faint";
      else if (outsideFrame(u.box, frame)) cat = "margin";
      else if (top >= footerY - EPS) cat = "pinned";
      else if (top >= y1 - EPS) cat = "below";
      else if (within(u.box)) cat = "band";
      else cat = "crosser";
      return Object.assign(u, { cat });
    });
  }

  // Text units of a page: pdf2htmlEX lines (or the clip box `.c` holding them)
  function textUnits(pageEl) {
    const seen = new Set();
    const out = [];
    for (const line of pageEl.querySelectorAll("[data-line]")) {
      const unit = line.closest(".c") && pageEl.contains(line.closest(".c")) ? line.closest(".c") : line;
      if (seen.has(unit)) continue;
      seen.add(unit);
      const r = document.createRange();
      r.selectNodeContents(unit);
      out.push({ el: unit, box: relRect(r.getBoundingClientRect(), pageEl) });
    }
    return out;
  }

  // Moves an absolutely positioned element down by dy CSS px (negative = up).
  function shiftEl(el, dy) {
    if (!dy) return;
    const before = el.getBoundingClientRect().top;
    const cs = getComputedStyle(el);
    const useBottom = cs.bottom !== "auto" && !el.style.top;
    const set = (d) => {
      if (useBottom) el.style.bottom = `${(parseFloat(cs.bottom) - d).toFixed(4)}px`;
      else el.style.top = `${((parseFloat(cs.top) || 0) + d).toFixed(4)}px`;
    };
    const base = useBottom ? parseFloat(cs.bottom) : parseFloat(cs.top) || 0;
    set(dy);
    const moved = el.getBoundingClientRect().top - before;
    if (Math.abs(moved - dy) > 0.01 && Math.abs(moved) > 0.001) {
      // the container is scaled: correct once by the measured ratio
      const d = (dy * dy) / moved;
      if (useBottom) el.style.bottom = `${(base - d).toFixed(4)}px`;
      else el.style.top = `${(base + d).toFixed(4)}px`;
    }
  }

  // ── group detection (§7.8) ──────────────────────────────────────────────────
  // groups: [{ key, mode: "repeat"|"fixed_rows", cells: [{ key, lineId, charStart, charEnd, sampleValue }],
  //            sampleRows?: number, footerY?: number, minPitchRatio? }]
  // → { [key]: { ok, error?, message?, …geometry } } — never mutates the document
  function horizontalLevels(units, x0, x1) {
    const width = x1 - x0;
    const levels = [];
    for (const u of units.filter((v) => v.horizontal)) {
      const overlap = Math.min(u.box.x + u.box.w, x1) - Math.max(u.box.x, x0);
      if (overlap <= 0) continue;
      const y = u.box.y + u.box.h / 2;
      let lvl = levels.find((l) => Math.abs(l.y - y) <= 0.75);
      if (!lvl) levels.push((lvl = { y, cover: 0, units: [] }));
      lvl.cover += overlap;
      lvl.units.push(u);
    }
    return levels.filter((l) => l.cover >= width * 0.5).sort((a, b) => a.y - b.y);
  }

  function proposeFooter(blocks, fromY, pageH) {
    // largest vertical whitespace below the group; the footer starts right after it
    const iv = blocks.filter((b) => b.y >= fromY - EPS).map((b) => [b.y, b.y + b.h]).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [a, b] of iv) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    let best = { gap: 0, y: pageH };
    for (let i = 1; i < merged.length; i++) {
      const gap = merged[i][0] - merged[i - 1][1];
      if (gap > best.gap) best = { gap, y: merged[i][0] - 2 };
    }
    const tail = merged.length ? pageH - merged[merged.length - 1][1] : pageH - fromY;
    if (best.gap < MIN_FOOTER_GAP || tail >= best.gap) return round(pageH);
    return round(best.y);
  }

  function inspectGroups(groups) {
    const out = {};
    for (const g of groups || []) {
      try {
        out[g.key] = inspectGroup(g);
      } catch (err) {
        out[g.key] = { ok: false, error: "GROUP_ENGINE_ERROR", message: String((err && err.message) || err) };
      }
    }
    return out;
  }

  function inspectGroup(g) {
    const fail = (error, message, extra) => ({ ok: false, error, message, ...(extra || {}) });
    if (!g.cells || !g.cells.length) return fail("GROUP_NO_CELLS", "Mark the cells of one sample row");
    const cells = [];
    let pageEl = null;
    for (const c of g.cells) {
      const line = lineEl(c.lineId);
      if (!line) return fail("LINE_NOT_FOUND", `Cell ${c.key}: line ${c.lineId} not found`);
      const range = rangeFromOffsets(line, c.charStart, c.charEnd);
      if (!range || range.toString() !== c.sampleValue) return fail("OFFSET_MISMATCH", `Cell ${c.key}: the text is not "${c.sampleValue}"`);
      const pe = pageOf(line);
      if (pageEl && pe !== pageEl) return fail("GROUP_CELLS_NOT_ONE_ROW", "All cells of a group must be on the same page");
      pageEl = pe;
      cells.push({ key: c.key, lineId: c.lineId, box: relRect(range.getBoundingClientRect(), pe) });
    }
    const rowTop = Math.min(...cells.map((c) => c.box.y));
    const rowBottom = Math.max(...cells.map((c) => c.box.y + c.box.h));
    if (cells.some((c) => Math.abs(c.box.y - rowTop) > 3)) return fail("GROUP_CELLS_NOT_ONE_ROW", "The cells of the sample row must sit on one line of the table");
    cells.sort((a, b) => a.box.x - b.box.x);
    const colX0 = cells[0].box.x;
    const colX1 = Math.max(...cells.map((c) => c.box.x + c.box.w));
    const lineH = Math.max(...cells.map((c) => c.box.h));
    const page = pageNo(pageEl);
    const pageR = pageEl.getBoundingClientRect();
    const pageH = round(pageR.height);
    const cellLines = new Set(cells.map((c) => c.lineId));

    // text rows under the sample row whose text lies entirely in the group columns
    const lines = textUnits(pageEl).map((t) => ({ ...t, id: t.el.getAttribute("data-line") }));
    const candidates = lines
      .filter((l) => !cellLines.has(l.id) && l.box.y > rowTop + 2 && l.box.x >= colX0 - 2 && l.box.x < colX1 + 2)
      .sort((a, b) => a.box.y - b.box.y);
    const textRows = [];
    for (const l of candidates) {
      const row = textRows.find((r) => Math.abs(r.y - l.box.y) <= 1.5);
      if (row) row.lines.push(l);
      else textRows.push({ y: l.box.y, lines: [l] });
    }
    let pitchText = null;
    const following = [];
    for (const r of textRows) {
      const j = following.length + 1;
      if (pitchText === null) {
        const p = r.y - rowTop;
        if (p <= lineH * 0.9 || p > lineH * 3) break;
        pitchText = p;
        following.push(r);
      } else if (Math.abs(r.y - (rowTop + j * pitchText)) <= 1.2) following.push(r);
      else break;
    }

    // background rules
    const svgImg = svgImages(pageEl)[0] || null;
    let svgCtx = null;
    let units = [];
    if (svgImg) {
      svgCtx = openSvg(svgImg, pageEl);
      units = flatUnits(svgCtx);
    }
    try {
      const levels = horizontalLevels(units, colX0, colX1);
      const above = levels.filter((l) => l.y <= rowTop + 1);
      const top = above.length ? above[above.length - 1] : null;
      const below = levels.filter((l) => l.y >= rowBottom - 1);
      const rulesFound = !!top && below.length > 0;
      const reasonNoRules = () => {
        if (!svgImg) return { error: "GROUP_NEEDS_SVG", message: "This version's background is a single raster image, so the table rules can't be told apart. Groups are defined on an SVG-background version (POST …/enable-groups)." };
        const band = { y0: top ? top.y : rowTop - 4, y1: rowBottom + 4 };
        const raster = units.find((u) => u.image && u.box.y < band.y1 && u.box.y + u.box.h > band.y0 && u.box.x < colX1 && u.box.x + u.box.w > colX0);
        if (raster) return { error: "GROUP_TABLE_RASTER", message: "The table around this row is a picture, not separate lines, so rows can't be added. Use fixed rows: the designer draws the maximum number of rows; unused rows are hidden and the gap is closed." };
        return { error: "GROUP_RULES_NOT_FOUND", message: "No table lines were found above and below this row, so rows can't be added. Use fixed rows: the designer draws the maximum number of rows; unused rows are hidden and the gap is closed." };
      };

      let shape;
      let y0;
      let y1;
      let k;
      let pitch;
      let pad = 0;
      let placeholderRows;
      if (rulesFound) {
        y0 = top.y;
        // rows of text inside the band between the sample row and the next rule = a list inside one cell
        const nextRule = below[0];
        const inside = following.filter((r) => r.y < nextRule.y - 1);
        if (inside.length) {
          shape = "cell_list";
          y1 = nextRule.y;
          k = 1 + inside.length;
          pitch = pitchText;
          pad = y1 - y0 - k * pitch;
          placeholderRows = inside;
        } else {
          shape = "table_rows";
          k = Math.max(1, Number(g.sampleRows) || 1);
          const levelsBelow = below.slice(0, k);
          if (levelsBelow.length < k) return fail("GROUP_SAMPLE_ROWS", `Only ${levelsBelow.length} table rows were found under the sample row, not ${k}`);
          y1 = levelsBelow[k - 1].y;
          pitch = (y1 - y0) / k;
          if (k > 1) {
            const steps = levelsBelow.map((l, i) => l.y - (i ? levelsBelow[i - 1].y : y0));
            if (steps.some((s) => Math.abs(s - pitch) > 1)) return fail("GROUP_SAMPLE_ROWS", "The sample rows don't have the same height");
          }
          placeholderRows = following.filter((r) => r.y < y1 - 1).slice(0, k - 1);
        }
      } else {
        if (g.mode !== "fixed_rows") {
          const r = reasonNoRules();
          return fail(r.error, r.message);
        }
        if (!following.length) return fail("GROUP_FIXED_NEEDS_ROWS", "Fixed rows need the maximum number of rows drawn in the design (at least two).");
        shape = "cell_list";
        pitch = pitchText;
        k = 1 + following.length;
        const half = Math.max(0, (pitch - lineH) / 2);
        y0 = rowTop - half;
        y1 = rowTop + (k - 1) * pitch + lineH + half;
        pad = y1 - y0 - k * pitch;
        placeholderRows = following;
      }
      if (g.mode === "fixed_rows" && k < 2) return fail("GROUP_FIXED_NEEDS_ROWS", "Fixed rows need the maximum number of rows drawn in the design (at least two).");

      // the table's frame: the horizontal extent of its rule above the sample row
      // (every rule segment on that line that chains to the group's columns)
      let frame = { x0: 0, x1: round(pageR.width) };
      if (rulesFound) {
        const segs = units.filter((u) => u.horizontal && Math.abs(u.box.y + u.box.h / 2 - top.y) <= 0.75).map((u) => [u.box.x, u.box.x + u.box.w]);
        let x0 = Math.min(...top.units.map((u) => u.box.x));
        let x1 = Math.max(...top.units.map((u) => u.box.x + u.box.w));
        for (let grew = true; grew; ) {
          grew = false;
          for (const [a, b] of segs) {
            if (a < x0 && b >= x0 - 3) (x0 = a), (grew = true);
            if (b > x1 && a <= x1 + 3) (x1 = b), (grew = true);
          }
        }
        frame = { x0: round(x0), x1: round(x1) };
      }
      // the same classification the fill uses
      const table = { x0: colX0 - 2, x1: colX1 + 2 };
      const cls = svgCtx ? classifyUnits(svgCtx, { y0, y1 }, pageH + 1, table, frame) : [];
      // a rule that crosses the band but belongs to the table = one combined drawing
      if (g.mode !== "fixed_rows") {
        const combined = cls.find((u) => u.cat === "crosser" && spansX(u.box, table) && (u.vertical || (u.stroked && !u.thin && u.subpaths > 4)));
        if (combined) {
          return fail("GROUP_RULES_COMBINED", "The table lines around this row are drawn as one shape, so rows can't be added. Use fixed rows: the designer draws the maximum number of rows; unused rows are hidden and the gap is closed.");
        }
      }

      // a normal one-line row of the same table (for "N = 1 looks like one normal row")
      let minRowHeight = shape === "cell_list" ? pad + pitch : pitch;
      let textAdj = 0;
      let normalRow = null;
      if (shape === "cell_list" && rulesFound) {
        const prev = levels.filter((l) => l.y < y0 - 1).pop();
        const next = below[1];
        const pick = (a, b) => {
          const t = lines.filter((l) => l.box.y > a + 0.5 && l.box.y + l.box.h < b - 0.5);
          return t.length ? { height: b - a, textOffset: Math.min(...t.map((l) => l.box.y)) - a } : null;
        };
        normalRow = (prev && pick(prev.y, y0)) || (next && pick(y1, next.y)) || null;
        if (normalRow && normalRow.height > minRowHeight) {
          minRowHeight = normalRow.height;
          textAdj = normalRow.textOffset - (rowTop - y0);
        }
      }

      // sample rows: row 1 = the cells' samples; rows 2..k = the placeholder text split per column
      const colStarts = cells.map((c) => c.box.x);
      const sampleRows = [Object.fromEntries(g.cells.map((c) => [c.key, c.sampleValue]))];
      for (const r of placeholderRows) {
        const row = Object.fromEntries(cells.map((c) => [c.key, ""]));
        for (const l of r.lines.sort((a, b) => a.box.x - b.box.x)) {
          // assign each character to the column it starts in
          for (const n of textNodes(l.el)) {
            for (let i = 0; i < n.data.length; i++) {
              const rr = document.createRange();
              rr.setStart(n, i);
              rr.setEnd(n, i + 1);
              const rect = rr.getBoundingClientRect();
              const x = rect.left - pageR.left;
              let col = 0;
              for (let ci = 0; ci < colStarts.length; ci++) if (x >= colStarts[ci] - 1.5) col = ci;
              row[cells[col].key] += n.data[i];
            }
          }
        }
        for (const key of Object.keys(row)) row[key] = row[key].replace(/\s+/g, " ").trim();
        sampleRows.push(row);
      }

      // footer line, capacity
      const blocks = lines.filter((l) => !cellLines.has(l.id) && !placeholderRows.some((r) => r.lines.includes(l)) && l.box.y >= y1 - EPS && !outsideFrame(l.box, frame)).map((l) => l.box);
      blocks.push(...cls.filter((u) => u.cat === "below").map((u) => u.box));
      const footerProposal = proposeFooter(blocks, y1, pageH);
      const footerY = Number.isFinite(g.footerY) && g.footerY > y1 ? g.footerY : footerProposal;
      const movable = blocks.filter((b) => b.y >= y1 - EPS && b.y < footerY - EPS);
      const movableBottom = Math.max(y1, ...movable.map((b) => b.y + b.h));
      const slack = round(footerY - FOOTER_GAP - movableBottom);
      const ratio = Number(g.minPitchRatio) || 0.85;
      const bandH = y1 - y0;
      const fit = (p) => (shape === "cell_list" ? Math.floor((slack + bandH - pad) / p + 1e-6) : Math.floor((slack + bandH) / p + 1e-6));
      const capacity = g.mode === "fixed_rows" ? { full: k, min: k } : { full: Math.max(0, fit(pitch)), min: Math.max(0, fit(pitch * ratio)) };

      return {
        ok: true,
        page,
        mode: g.mode || "repeat",
        shape,
        band: { y0: round(y0), y1: round(y1) },
        table: { x0: round(colX0), x1: round(colX1) },
        frame,
        rowTop: round(rowTop),
        lineHeight: round(lineH),
        pitch: round(pitch),
        pad: round(pad),
        sampleRowCount: k,
        sampleRows,
        placeholderLines: placeholderRows.flatMap((r) => r.lines.map((l) => l.id)),
        minRowHeight: round(minRowHeight),
        textAdj: round(textAdj),
        normalRow,
        columns: cells.map((c) => ({ key: c.key, x: c.box.x, w: c.box.w })),
        verticalRules: units.filter((u) => u.vertical && u.box.y >= y0 - EPS && u.box.y + u.box.h <= y1 + EPS).length,
        rulesFound,
        footerProposal,
        footerY: round(footerY),
        slack,
        capacity,
        minPitchRatio: ratio,
        background: svgImg ? "svg" : "raster",
      };
    } finally {
      if (svgCtx) svgCtx.close();
    }
  }

  // How a group's geometry classifies the page's background (tests, diagnostics):
  // → [{ cat, tag, box }]
  function backgroundUnits(geo, footerY) {
    const pageEl = pageEls().find((p) => pageNo(p) === geo.page) || pageEls()[0];
    const img = svgImages(pageEl)[0];
    if (!img) return [];
    const ctx = openSvg(img, pageEl);
    try {
      const table = { x0: geo.table.x0 - 2, x1: geo.table.x1 + 2 };
      return classifyUnits(ctx, geo.band, Number.isFinite(footerY) ? footerY : geo.footerY, table, geo.frame).map((u) => ({ cat: u.cat, tag: u.tag, box: u.box, faint: u.faint }));
    } finally {
      ctx.close();
    }
  }

  // prepare: the placeholder rows (2..k) are removed; row 1 is cloned at fill
  function removeGroupPlaceholders(geometries) {
    let removed = 0;
    for (const geo of Object.values(geometries || {})) {
      for (const id of geo.placeholderLines || []) {
        const l = lineEl(id);
        if (l) {
          (l.closest(".c") || l).remove();
          removed++;
        }
      }
    }
    return { removed };
  }

  // ── group fill (§7.8) ───────────────────────────────────────────────────────
  // g: { key, mode, whenEmpty, required, footerY, minPitchRatio, geometry, cells: [fillDef] }
  // rows: [{ cellKey: text }] → { flags, info: { rows, rendered, pitch, delta, rowsFit } }
  async function fillGroup(g, rowsIn, coverage) {
    const geo = g.geometry;
    const flags = new Set();
    const info = { rows: 0, rendered: 0, pitch: geo ? geo.pitch : null, delta: 0, rowsFit: null };
    if (!geo || !geo.band) return { flags: ["missing_span"], info };
    const pageEl = pageEls().find((p) => pageNo(p) === geo.page) || pageEls()[0];
    const cellKeys = g.cells.map((c) => c.key);
    let rows = Array.isArray(rowsIn) ? rowsIn.map((r) => (r && typeof r === "object" ? r : {})) : [];
    info.rows = rows.length;
    const hide = rows.length === 0 && g.whenEmpty === "hide";
    if (rows.length === 0) {
      if (g.required !== false) flags.add("missing");
      if (!hide) rows = [{ [cellKeys[0]]: "—" }];
    }

    const { y0, y1 } = geo.band;
    const bandH = y1 - y0;
    const footerY = Number.isFinite(g.footerY) ? g.footerY : geo.footerY;
    const k = geo.sampleRowCount;
    const shape = geo.shape;
    const fixed = g.mode === "fixed_rows";
    const p0 = geo.pitch;

    // text units, measured before anything moves
    const spans = cellKeys.map((key) => document.querySelector(`[data-field="${cssEscape(key)}"]`));
    if (spans.some((s) => !s)) return { flags: ["missing_span"], info };
    const rowLines = [];
    for (const s of spans) {
      const l = s.closest("[data-line]");
      if (l && !rowLines.includes(l)) rowLines.push(l);
    }
    const texts = textUnits(pageEl);
    const inBandText = texts.filter((t) => t.box.y + t.box.h / 2 > y0 && t.box.y + t.box.h / 2 < y1);
    const frame = geo.frame || null;
    const belowText = texts.filter((t) => t.box.y >= y1 - EPS && t.box.y < footerY - EPS && !outsideFrame(t.box, frame));

    let N = rows.length;
    if (fixed && N > k) {
      flags.add("overflow");
      info.rowsFit = k;
      N = k;
      rows = rows.slice(0, k);
    }

    // pitch and delta
    let p = p0;
    const natural = (n, pp) => (hide ? 0 : shape === "cell_list" ? Math.max(geo.minRowHeight, geo.pad + n * pp) : n * pp);
    let delta;
    if (fixed) {
      delta = hide ? -bandH : -(k - N) * p0;
    } else {
      const svgUnitsBottom = [];
      const ctx0 = svgImages(pageEl)[0] ? openSvg(svgImages(pageEl)[0], pageEl) : null;
      if (ctx0) {
        const table = { x0: geo.table.x0 - 2, x1: geo.table.x1 + 2 };
        for (const u of classifyUnits(ctx0, geo.band, footerY, table, frame)) if (u.cat === "below") svgUnitsBottom.push(u.box.y + u.box.h);
        ctx0.close();
      }
      const movableBottom = Math.max(y1, ...belowText.map((t) => t.box.y + t.box.h), ...svgUnitsBottom);
      const slack = footerY - FOOTER_GAP - movableBottom;
      const ratio = Number(g.minPitchRatio) || geo.minPitchRatio || 0.85;
      const fitRows = (pp) => (shape === "cell_list" ? Math.floor((slack + bandH - geo.pad) / pp + 1e-6) : Math.floor((slack + bandH) / pp + 1e-6));
      if (!hide && natural(N, p0) - bandH > slack + 0.01) {
        const need = shape === "cell_list" ? (slack + bandH - geo.pad) / N : (slack + bandH) / N;
        p = Math.max(need, p0 * ratio);
        if (p < p0 - 1e-6) flags.add("shrunk");
        if (natural(N, p) - bandH > slack + 0.5) {
          flags.add("overflow");
          info.rowsFit = Math.max(0, fitRows(p0 * ratio));
        }
      }
      delta = natural(N, p) - bandH;
      if (info.rowsFit === null) info.rowsFit = Math.max(N, fitRows(p0 * ratio));
    }
    info.pitch = round(p);
    info.delta = round(delta);
    info.rendered = hide ? 0 : N;
    const rowAdj = !fixed && shape === "cell_list" && !hide && geo.pad + N * p < geo.minRowHeight - 1e-6 ? geo.textAdj || 0 : 0;

    // ── text ──
    if (hide) {
      for (const t of inBandText) t.el.remove();
    } else {
      // row 1: the cells themselves; rows 2..N: clones of row 1's lines with only the cells visible
      for (let i = N - 1; i >= 1; i--) {
        for (const line of rowLines) {
          const clone = line.cloneNode(true);
          clone.removeAttribute("data-line");
          clone.style.visibility = "hidden";
          clone.querySelectorAll("[data-field]").forEach((s) => {
            const key = s.getAttribute("data-field");
            s.removeAttribute("data-field");
            if (cellKeys.includes(key)) {
              s.setAttribute("data-group-cell", `${g.key}:${i}:${key}`);
              s.style.visibility = "visible";
            } else s.textContent = "";
          });
          line.after(clone);
          shiftEl(clone, i * p + rowAdj);
        }
      }
      for (const line of rowLines) shiftEl(line, rowAdj);
      spans.forEach((s, ci) => s.setAttribute("data-group-cell", `${g.key}:0:${cellKeys[ci]}`));
      for (let i = 0; i < N; i++) {
        for (const def of g.cells) {
          const s = document.querySelector(`[data-group-cell="${cssEscape(`${g.key}:${i}:${def.key}`)}"]`);
          if (!s) continue;
          const raw = rows[i][def.key];
          const value = raw === null || raw === undefined ? "" : String(raw);
          s.textContent = value;
          const res = layoutField(s, def);
          for (const f of res.flags) flags.add(f);
          for (const f of glyphFlags(value, def, coverage)) flags.add(f);
        }
      }
    }
    for (const t of belowText) shiftEl(t.el, delta);

    // ── background ──
    if (fixed) {
      if (delta) sliceBackground(pageEl, hide ? y0 : geo.rowTop + N * p0 - 1, hide ? y1 : geo.rowTop + k * p0 - 1, footerY, delta, frame);
    } else {
      const img = svgImages(pageEl)[0];
      if (!img) return { flags: [...flags, "missing_span"], info };
      const ctx = openSvg(img, pageEl);
      const table = { x0: geo.table.x0 - 2, x1: geo.table.x1 + 2 };
      const units = classifyUnits(ctx, geo.band, footerY, table, frame);
      const onLevel = (u, y) => u.horizontal && Math.abs(u.box.y + u.box.h / 2 - y) <= EPS && overlapX(u.box, table) > 0;
      const rowBottomY = y0 + p0; // table_rows: row 1's bottom rule
      const dp = p - p0; // pitch change per row (≤ 0)
      for (const u of units) {
        if (u.cat === "below") {
          if (hide && onLevel(u, y1)) ctx.remove(u); // the band's bottom rule goes with the row
          else if (!hide && shape === "table_rows" && k === 1 && onLevel(u, y1)) {
            // k = 1: the band's bottom rule is row 1's — one per row
            for (let i = 1; i < N; i++) ctx.clone(u, ctx.mShift(i * p + dp));
            ctx.shift(u, dp);
          } else ctx.shift(u, delta);
          continue;
        }
        if (u.cat !== "band") continue; // above, faint, pinned, crosser: never touched
        if (hide) {
          ctx.remove(u);
          continue;
        }
        const b = u.box;
        if (shape === "cell_list") {
          if (u.vertical || b.h >= 0.8 * bandH) ctx.stretch(u, delta);
          continue;
        }
        // table_rows, k > 1: row 1's members are repeated, rows 2..k's are placeholders
        if (onLevel(u, rowBottomY)) {
          // the band's own bottom rule draws the last row's bottom
          for (let i = 1; i < N - 1; i++) ctx.clone(u, ctx.mShift(i * p + dp));
          if (N > 1) ctx.shift(u, dp);
          else ctx.remove(u);
          continue;
        }
        if (b.y >= rowBottomY - EPS) {
          ctx.remove(u);
          continue;
        }
        const tall = u.vertical || b.h >= 0.8 * p0;
        const m = tall ? ctx.mStretch(u, dp) : new DOMMatrix();
        for (let i = 1; i < N; i++) ctx.clone(u, ctx.mShift(i * p).multiply(m));
        if (tall) ctx.stretch(u, dp);
      }
      await ctx.commit();
    }
    return { flags: mergeGlyphFlags([...flags]), info };
  }

  // one "glyph:…" flag with every missing character (cells report their own)
  function mergeGlyphFlags(list) {
    const chars = [];
    const rest = [];
    for (const f of list) {
      if (String(f).startsWith("glyph:")) for (const ch of Array.from(f.slice(6))) !chars.includes(ch) && chars.push(ch);
      else rest.push(f);
    }
    return chars.length ? [...rest, `glyph:${chars.join("")}`] : rest;
  }

  // fixed rows: cut [cutTop, cutBottom) out of the background inside the
  // table's frame; what is below it (up to the footer line) moves up by
  // `delta` (< 0). The footer and the side margins stay where they are.
  function sliceBackground(pageEl, cutTop, cutBottom, footerY, delta, frame) {
    const imgs = Array.from(pageEl.querySelectorAll("img")).filter((i) => /\bb[fi]\b/.test(i.className) || svgImages(pageEl).includes(i));
    for (const img of imgs) {
      const ir = relRect(img.getBoundingClientRect(), pageEl);
      const sx = img.offsetWidth ? ir.w / img.offsetWidth : 1;
      const sy = img.offsetHeight ? ir.h / img.offsetHeight : 1;
      // in the image's own CSS px
      const X = (x) => ((x - ir.x) / sx).toFixed(3);
      const Y = (y) => ((y - ir.y) / sy).toFixed(3);
      const W = (ir.w / sx).toFixed(3);
      const H = (ir.h / sy).toFixed(3);
      const fx0 = frame ? frame.x0 - 2 : ir.x;
      const fx1 = frame ? frame.x1 + 2 : ir.x + ir.w;
      const bottom = Math.min(footerY, ir.y + ir.h);
      // the original keeps everything except the frame's area from the cut down to the footer line
      img.style.clipPath = `polygon(evenodd, 0 0, ${W}px 0, ${W}px ${H}px, 0 ${H}px, 0 0, ${X(fx0)}px ${Y(cutTop)}px, ${X(fx1)}px ${Y(cutTop)}px, ${X(fx1)}px ${Y(bottom)}px, ${X(fx0)}px ${Y(bottom)}px, ${X(fx0)}px ${Y(cutTop)}px)`;
      // a copy shows what was below the cut, moved up
      const mid = img.cloneNode(true);
      mid.style.clipPath = `polygon(${X(fx0)}px ${Y(cutBottom)}px, ${X(fx1)}px ${Y(cutBottom)}px, ${X(fx1)}px ${Y(bottom)}px, ${X(fx0)}px ${Y(bottom)}px)`;
      mid.style.transform = `translateY(${(delta / sy).toFixed(3)}px)`;
      img.after(mid);
    }
  }

  // ── fill (§7.4) ─────────────────────────────────────────────────────────────
  // values: { key: string, [groupKey]: [{ cellKey: string }] }
  // defs: [{ key, box, limits, scale, align, required, fontClass }]
  // coverage: { ff1: "ABC…" } | null · groups: group defs (§7.8), optional
  function glyphFlags(value, def, coverage) {
    const cov = coverage && def.fontClass ? coverage[def.fontClass] : null;
    if (value && typeof cov === "string") {
      const covered = new Set(Array.from(cov));
      const missing = [];
      for (const ch of Array.from(value)) {
        if (/\s/.test(ch) || covered.has(ch) || missing.includes(ch)) continue;
        missing.push(ch);
      }
      return missing.length ? [`glyph:${missing.join("")}`] : [];
    }
    if (value && coverage && def.fontClass && cov === null && Object.prototype.hasOwnProperty.call(coverage, def.fontClass)) {
      // the design embeds this font but it couldn't be parsed: whether every
      // character exists is unknown — say so (non-blocking), never guess
      return ["glyph_unknown"];
    }
    return [];
  }

  async function fill(values, defs, coverage, groups) {
    const flags = {};
    const geometry = {};
    for (const def of defs) {
      const span = document.querySelector(`[data-field="${cssEscape(def.key)}"]`);
      const list = [];
      if (!span) {
        flags[def.key] = ["missing_span"];
        continue;
      }
      const raw = values[def.key];
      const value = raw === null || raw === undefined ? "" : String(raw);
      span.textContent = value;
      const res = layoutField(span, def);
      list.push(...res.flags, ...glyphFlags(value, def, coverage));
      if (!value && def.required) list.push("missing");
      flags[def.key] = list;
      geometry[def.key] = { ...res.extent, fontScale: res.fontScale };
    }
    for (const g of groups || []) {
      const res = await fillGroup(g, values[g.key], coverage);
      flags[g.key] = res.flags;
      geometry[g.key] = res.info;
    }
    return { flags, geometry };
  }

  // page-relative rect of each field span (round-trip gate §7.5)
  function measure(keys) {
    const out = {};
    for (const key of keys) {
      const span = document.querySelector(`[data-field="${cssEscape(key)}"]`);
      if (!span) continue;
      out[key] = relRect(span.getBoundingClientRect(), pageOf(span));
    }
    return out;
  }

  // positions of every text run on every page — the anchoring tests use this
  // to prove neighbours did not move
  function runPositions(excludeFields) {
    const out = [];
    for (const pageEl of pageEls()) {
      for (const run of visibleRuns(pageEl, null)) {
        const inField = run.node.parentElement.closest("[data-field]");
        if (excludeFields && inField) continue;
        out.push({ page: pageNo(pageEl), text: run.node.data, x: run.rect.x, y: run.rect.y });
      }
    }
    return out;
  }

  // ── serialize (D9, §7.7) ─────────────────────────────────────────────────────
  function serialize() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll(`[${ENGINE_ATTR}]`).forEach((el) => el.remove());
    clone.querySelectorAll("[contenteditable],[spellcheck]").forEach((el) => {
      el.removeAttribute("contenteditable");
      el.removeAttribute("spellcheck");
    });
    clone.querySelectorAll("script").forEach((el) => el.remove());
    return `<!DOCTYPE html>\n${clone.outerHTML}`;
  }

  window.__certEngine = {
    analyse,
    markGenericLines,
    inspect,
    clear,
    fill,
    measure,
    runPositions,
    serialize,
    normalizeBackground,
    inspectGroups,
    removeGroupPlaceholders,
    backgroundUnits,
    hasSvgBackground: () => pageEls().some(pageHasSvgBackground),
    TOL,
  };
})();
