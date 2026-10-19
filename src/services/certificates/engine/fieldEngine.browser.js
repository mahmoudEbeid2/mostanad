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
      out[f.key] = { ok: true, page: pageNo(pageEl), box, header, suggestedAlign };
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

  // ── fill (§7.4) ─────────────────────────────────────────────────────────────
  // values: { key: string } · defs: [{ key, box, limits, scale, align, required, fontClass }]
  // coverage: { ff1: "ABC…" } | null
  function fill(values, defs, coverage) {
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
      list.push(...res.flags);

      const cov = coverage && def.fontClass ? coverage[def.fontClass] : null;
      if (value && typeof cov === "string") {
        const covered = new Set(Array.from(cov));
        const missing = [];
        for (const ch of Array.from(value)) {
          if (/\s/.test(ch) || covered.has(ch) || missing.includes(ch)) continue;
          missing.push(ch);
        }
        if (missing.length) list.push(`glyph:${missing.join("")}`);
      } else if (value && coverage && def.fontClass && cov === null && Object.prototype.hasOwnProperty.call(coverage, def.fontClass)) {
        // the design embeds this font but it couldn't be parsed: whether every
        // character exists is unknown — say so (non-blocking), never guess
        list.push("glyph_unknown");
      }
      if (!value && def.required) list.push("missing");
      flags[def.key] = list;
      geometry[def.key] = { ...res.extent, fontScale: res.fontScale };
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

  window.__certEngine = { analyse, markGenericLines, inspect, clear, fill, measure, runPositions, serialize, TOL };
})();
