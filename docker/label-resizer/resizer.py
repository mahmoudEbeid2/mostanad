"""Label resize that keeps the ORIGINAL design (PyMuPDF).

A designed label (PDF, or .ai saved with PDF compatibility) at another size, like
resizing an artboard: same logo, colours, fonts, boxes and wording.

Why PyMuPDF: it places any region of the original page into the new page as a
vector Form XObject (show_pdf_page with a clip), so artwork, gradients, fonts and
kerning are the original's, byte for byte — nothing is redrawn or rasterised. Text
that must re-wrap is re-set from its spans with the label's own embedded font.

Same aspect ratio  → the whole page, vector-scaled (exact design).
Other aspect ratio → "smart" layout:
  background  — a text-free copy of the page with the artwork clusters cut out,
                stretched to the new page: bands, boxes, frames and lines follow the
                changed axis;
  artwork     — logos, images, curved shapes (clustered), placed uniformly scaled
                (never distorted) at their anchor (edge, centre or proportional);
  text blocks — placed as exact copies of the original text (each from a page that
                holds only that block's text), uniformly scaled at their anchor; a
                paragraph re-wraps when the new layout gives it more width, or when
                legible text would fall under the minimum size (then it grows into
                the free space below; what still doesn't fit is reported, no PDF).
Wording, numbers and units are never changed: re-set text is the original spans'
text, in their order.
"""

import collections
import math
import os
import re

import pymupdf

MM = 72 / 25.4
FONT_DIR = os.environ.get("RESIZER_FONT_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
CROP_SLUG_MM = 6.0  # paper outside the bleed that carries the crop marks
SAME_RATIO_TOLERANCE = 0.01
BACKGROUND_AREA = 0.35  # a curved shape or image this big is background (stretched), not artwork
EDGE = 0.06  # within 6 % of an edge = attached to it


def mm(v):
    return round(v / MM, 2)


def _rect(r):
    return [round(r.x0, 2), round(r.y0, 2), round(r.x1, 2), round(r.y1, 2)]


# ── decomposition ────────────────────────────────────────────────────────────
def _is_curved(d):
    for it in d["items"]:
        if it[0] == "c":
            return True
        if it[0] == "qu":
            q = it[1]
            if not (abs(q.ul.y - q.ur.y) < 0.5 and abs(q.ul.x - q.ll.x) < 0.5):
                return True
        if it[0] == "l":
            a, b = it[1], it[2]
            if abs(a.x - b.x) > 0.5 and abs(a.y - b.y) > 0.5:
                return True  # a diagonal line is drawing, not a band edge
    return False


def _clusters(rects, page_rect, cell=1.5 * MM):
    """Connected groups of rectangles on a coarse grid → [Rect] (fast for thousands of shapes)."""
    if not rects:
        return []
    cols = max(1, int(page_rect.width / cell) + 1)
    rows = max(1, int(page_rect.height / cell) + 1)
    owner = {}
    for k, r in enumerate(rects):
        x0 = max(0, int((r.x0 - page_rect.x0) / cell))
        x1 = min(cols - 1, int((r.x1 - page_rect.x0) / cell))
        y0 = max(0, int((r.y0 - page_rect.y0) / cell))
        y1 = min(rows - 1, int((r.y1 - page_rect.y0) / cell))
        for cx in range(x0, x1 + 1):
            for cy in range(y0, y1 + 1):
                owner.setdefault((cx, cy), []).append(k)
    parent = list(range(len(rects)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for (cx, cy), ks in owner.items():
        for k in ks[1:]:
            union(ks[0], k)
        for dx, dy in ((1, 0), (0, 1), (1, 1), (1, -1)):
            nb = owner.get((cx + dx, cy + dy))
            if nb:
                union(ks[0], nb[0])
    groups = {}
    for k in range(len(rects)):
        groups.setdefault(find(k), pymupdf.Rect(rects[k]))
        groups[find(k)] |= rects[k]
    return list(groups.values())


def _line_dir_ok(line):
    dx, dy = line.get("dir", (1, 0))
    return abs(dx - 1) < 0.01 and abs(dy) < 0.01


def _role(block, sizes_median, size_max):
    size = block["size"]
    text = block["text"].strip()
    if size >= size_max - 0.01 and size >= sizes_median * 1.5:
        return "product_name"
    if block["rotated"]:
        return "rotated_text"
    if re.fullmatch(r"[\d\s]{8,}", text):
        return "barcode_digits"
    if sum(1 for l in block["lines"] if l["gaps"]) >= 2 or any(len(l["spans"]) >= 3 and l["gaps"] for l in block["lines"]):
        return "table"  # columns (composition: name … amount) are never re-wrapped
    # lines side by side on one baseline (a name column and an amount column) are a table too
    ls = block["lines"]
    for i in range(len(ls)):
        for j in range(i + 1, len(ls)):
            a, b = ls[i]["bbox"], ls[j]["bbox"]
            if min(a.y1, b.y1) - max(a.y0, b.y0) > 0.5 * min(a.height, b.height) and (a.x1 <= b.x0 + 0.5 or b.x1 <= a.x0 + 0.5):
                return "table"
    if size >= sizes_median * 1.3 or (len(text) < 40 and text.upper() == text and block["bold"]):
        return "heading"
    return "paragraph"


def analyse(doc, pno=0):
    """The page as blocks: text blocks, artwork clusters (with the text on them), background."""
    page = doc[pno]
    R = page.rect
    area = R.width * R.height
    d = page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_MEDIABOX_CLIP)
    texts = []
    for b in d["blocks"]:
        if b["type"] != 0:
            continue
        lines = []
        for l in b["lines"]:
            # in reading order: a file may store a line's runs in any order
            spans = sorted((s for s in l["spans"] if s["text"].strip()), key=lambda s: s["bbox"][0]) if _line_dir_ok(l) else [s for s in l["spans"] if s["text"].strip()]
            if not spans:
                continue
            gaps = any(spans[i + 1]["bbox"][0] - spans[i]["bbox"][2] > 2 * spans[i]["size"] for i in range(len(spans) - 1))
            lines.append({"bbox": pymupdf.Rect(l["bbox"]), "spans": spans, "dir_ok": _line_dir_ok(l), "gaps": gaps})
        if not lines:
            continue
        spans = [s for l in lines for s in l["spans"]]
        main = max(spans, key=lambda s: len(s["text"]))
        bbox = pymupdf.Rect(lines[0]["bbox"])
        for l in lines[1:]:
            bbox |= l["bbox"]
        texts.append({
            "lines": lines,
            "bbox": bbox,
            "size": main["size"],
            "font": main["font"],
            "color": main["color"],
            "bold": bool(main["flags"] & 16) or "bold" in main["font"].lower(),
            "rotated": not all(l["dir_ok"] for l in lines),
            "text": " ".join(s["text"] for s in spans),
            "min_size": min(s["size"] for s in spans),
        })
    # text blocks that overlap are one block: each block's copy would carry the other's words
    merged = True
    while merged:
        merged = False
        for i in range(len(texts)):
            for j in range(i + 1, len(texts)):
                a, b2 = texts[i], texts[j]
                inter = a["bbox"] & b2["bbox"]
                if not inter.is_empty and inter.width > 0.3 and inter.height > 0.3:
                    a["lines"] = sorted(a["lines"] + b2["lines"], key=lambda l: (round(l["bbox"].y0, 1), l["bbox"].x0))
                    a["bbox"] |= b2["bbox"]
                    a["text"] = " ".join(sp["text"] for l in a["lines"] for sp in l["spans"])
                    a["min_size"] = min(a["min_size"], b2["min_size"])
                    a["rotated"] = a["rotated"] or b2["rotated"]
                    if b2["size"] > a["size"]:
                        a.update({k: b2[k] for k in ("size", "font", "color", "bold")})
                    del texts[j]
                    merged = True
                    break
            if merged:
                break
    sizes = sorted(t["size"] for t in texts) or [10]
    median = sizes[len(sizes) // 2]
    # lines of one paragraph (or rows of one table) that the file stores as separate blocks:
    # one under the other, same left edge, same size and colour, at line spacing → one block,
    # so the paragraph re-wraps as a whole
    texts.sort(key=lambda t: (t["bbox"].y0, t["bbox"].x0))
    k = 0
    while k < len(texts):
        a = texts[k]
        joined = False
        for j in range(k + 1, len(texts)):
            b2 = texts[j]
            gap = b2["bbox"].y0 - a["lines"][-1]["bbox"].y1
            if gap > 0.8 * a["size"]:
                break  # sorted by top: nothing further down can be the next line
            same = (abs(b2["bbox"].x0 - a["bbox"].x0) < 1.5 and abs(b2["size"] - a["size"]) < 0.3 and b2["color"] == a["color"] and b2["bold"] == a["bold"]
                    and not a["rotated"] and not b2["rotated"] and -0.3 * a["size"] < gap
                    and (_role(a, median, sizes[-1]) == "table") == (_role(b2, median, sizes[-1]) == "table"))
            if same:
                a["lines"] += b2["lines"]
                a["bbox"] |= b2["bbox"]
                a["text"] = " ".join(sp["text"] for l in a["lines"] for sp in l["spans"])
                a["min_size"] = min(a["min_size"], b2["min_size"])
                del texts[j]
                joined = True
                break
        if not joined:
            k += 1
    for k, t in enumerate(texts):
        t["id"] = f"t{k}"
        t["role"] = _role(t, median, sizes[-1])

    # panels: filled rectangles (bands, boxes, a box net's panels). The background stretches, so
    # each panel maps exactly to (x × sx, y × sy); a block on a panel keeps its place IN the panel
    panels = []
    drawings = page.get_drawings()
    for dr in drawings:
        if dr.get("fill") is None or _is_curved(dr):
            continue
        r = pymupdf.Rect(dr["rect"]) & R
        if r.is_empty or not (area * 0.015 < r.width * r.height < area * 0.95):
            continue
        if all(it[0] in ("re", "l", "qu") for it in dr["items"]):
            panels.append(r)
    # artwork: images and curved shapes, clustered; huge ones are background
    art = []
    for info in page.get_image_info():
        r = pymupdf.Rect(info["bbox"]) & R
        if r.is_empty:
            continue
        if r.width * r.height < area * BACKGROUND_AREA:
            art.append(r)
    for dr in drawings:
        r = pymupdf.Rect(dr["rect"]) & R
        if r.is_empty or r.width * r.height < 0.5:
            continue
        if _is_curved(dr) and r.width * r.height < area * BACKGROUND_AREA:
            art.append(r)
    # a small outline drawn around text (a badge, a boxed word): it belongs to that text, so it
    # moves and scales with it instead of stretching with the background
    frames = []
    for dr in drawings:
        if dr.get("fill") is not None or not dr.get("color"):
            continue
        r = pymupdf.Rect(dr["rect"]) & R
        if r.is_empty or r.width * r.height > area * 0.05:
            continue
        # a badge: tight around ONE text (a box holding paragraphs stays a panel that stretches)
        inside = [t for t in texts if (t["bbox"] & r).width * (t["bbox"] & r).height > 0.9 * t["bbox"].width * t["bbox"].height]
        if len(inside) == 1 and r.width * r.height <= 2.5 * inside[0]["bbox"].width * inside[0]["bbox"].height:
            frames.append(r)
    clusters = [c for c in _clusters(art + frames, R) if c.width * c.height > (2 * MM) ** 2]
    # a cluster swallowing most of the page is background after all
    clusters = [c for c in clusters if c.width * c.height < area * 0.6]
    # a picture keeps its proportions even when it sits in a texture that is background
    # (a cluster dropped above): it is its own group, or joins the group it touches
    for info in page.get_image_info():
        r = pymupdf.Rect(info["bbox"]) & R
        if r.is_empty or r.width * r.height >= area * BACKGROUND_AREA:
            continue
        if any((r & c).width * (r & c).height >= 0.9 * r.width * r.height for c in clusters):
            continue
        touching = [k for k, c in enumerate(clusters) if r.intersects(c)]
        if touching:
            clusters[touching[0]] = clusters[touching[0]] | r
        else:
            clusters.append(r)
    # the same for a text frame lost in a texture: its own group (or joins a small group it touches)
    for r in frames:
        if any((r & c).width * (r & c).height >= 0.9 * r.width * r.height for c in clusters):
            continue
        touching = [k for k, c in enumerate(clusters) if r.intersects(c) and c.width * c.height < 4 * r.width * r.height]
        if touching:
            clusters[touching[0]] = clusters[touching[0]] | r
        else:
            clusters.append(r)
    groups = []
    for k, c in enumerate(clusters):
        groups.append({"id": f"g{k}", "bbox": c, "texts": [], "role": "image"})
    for t in texts:
        for g in groups:
            inter = t["bbox"] & g["bbox"]
            if not inter.is_empty and inter.width * inter.height > 0.6 * t["bbox"].width * t["bbox"].height:
                g["texts"].append(t["id"])
                t["group"] = g["id"]
                break
    has_image = {k for k, g in enumerate(groups) if any(not (pymupdf.Rect(i["bbox"]) & g["bbox"]).is_empty for i in page.get_image_info())}
    for k, g in enumerate(groups):
        g["role"] = "logo_or_image" if k in has_image or g["texts"] else "artwork"
    return {"page": page, "rect": R, "texts": texts, "groups": groups, "panels": panels, "box_net": _is_box_net(page, texts, drawings)}


def _is_box_net(page, texts, drawings):
    """A packaging net (a box's faces, flaps and cut / fold lines) rather than a label: its faces
    repeat the same text, and the paper around its outline is left unpainted — or it has dashed
    fold lines. Its proportions are the box's: re-arranging them would make another box."""
    R = page.rect
    per = 2 * (R.width + R.height)
    dashed = sum(math.dist(it[1], it[2]) for dr in drawings if dr.get("dashes") and dr["dashes"].strip() not in ("[] 0", "[] 0.0", "") for it in dr["items"] if it[0] == "l")
    if dashed > 0.3 * per:
        return True
    seen = collections.Counter(" ".join(t["text"].split()).lower() for t in texts if len(t["text"].strip()) >= 4)
    repeats = sum(v - 1 for v in seen.values() if v > 1)
    if repeats < 4:
        return False
    alpha = page.get_pixmap(dpi=12, alpha=True).samples[3::4]
    return sum(1 for x in alpha if x == 0) / max(1, len(alpha)) > 0.25


def container_of(r, panels, R):
    """The smallest panel that holds (90 % of) the rect, else the page."""
    best = None
    for p in panels:
        inter = r & p
        if inter.is_empty or inter.width * inter.height < 0.9 * r.width * r.height:
            continue
        if p.width >= R.width * 0.98 and p.height >= R.height * 0.98:
            continue
        if best is None or p.width * p.height < best.width * best.height:
            best = p
    return best or R


def _anchor(r, R):
    def axis(a0, a1, lo, hi):
        size = hi - lo
        if a0 - lo < EDGE * size and hi - a1 < EDGE * size:
            return "stretch"
        if a0 - lo < EDGE * size:
            return "start"
        if hi - a1 < EDGE * size:
            return "end"
        if abs((a0 + a1) / 2 - (lo + hi) / 2) < EDGE * size:
            return "center"
        return "proportional"

    return {"h": axis(r.x0, r.x1, R.x0, R.x1), "v": axis(r.y0, r.y1, R.y0, R.y1)}


def _place(r, R, W2, H2, sx, sy, u, anchor, size=None, C=None):
    """The rect `r` (original) at the new size: its size × u (or `size`), position by its anchor —
    in its container C (a panel; default the page), which the stretched background maps to
    (C.x0 × sx … C.x1 × sx, C.y0 × sy … C.y1 × sy)."""
    w = size[0] if size else r.width * u
    h = size[1] if size else r.height * u
    if C is not None and C != R:
        C1 = pymupdf.Rect(C.x0 * sx, C.y0 * sy, C.x1 * sx, C.y1 * sy)
        local = pymupdf.Rect(r.x0 - C.x0, r.y0 - C.y0, r.x1 - C.x0, r.y1 - C.y0)
        inner = _place(local, pymupdf.Rect(0, 0, C.width, C.height), C1.width, C1.height, C1.width / C.width, C1.height / C.height, u, _anchor(r, C), size=(w, h))
        return inner + (C1.x0, C1.y0, C1.x0, C1.y0)

    def axis(a0, a1, lo, hi, new, s, length, mode):
        if mode == "start":
            p0 = (a0 - lo) * u
        elif mode == "end":
            p0 = new - (hi - a1) * u - length
        elif mode == "center" or mode == "stretch":
            p0 = new / 2 + ((a0 + a1) / 2 - (lo + hi) / 2) * u - length / 2
        else:
            p0 = ((a0 + a1) / 2 - lo) * s - length / 2
        return p0

    x0 = axis(r.x0, r.x1, R.x0, R.x1, W2, sx, w, anchor["h"])
    y0 = axis(r.y0, r.y1, R.y0, R.y1, H2, sy, h, anchor["v"])
    return pymupdf.Rect(x0, y0, x0 + w, y0 + h)


# ── text re-set (only for blocks that must re-wrap) ─────────────────────────
_font_cache = {}


def _fallback(bold):
    name = "NotoSans-Bold.ttf" if bold else "NotoSans-Regular.ttf"
    if name not in _font_cache:
        path = os.path.join(FONT_DIR, name)
        _font_cache[name] = pymupdf.Font(fontfile=path) if os.path.exists(path) else pymupdf.Font("helv")
    return _font_cache[name]


def _fonts_of(doc, page):
    """basefont name (without the subset tag) → Font, for the label's embedded fonts."""
    out = {}
    for xref, ext, typ, base, *_ in page.get_fonts(full=True):
        key = base.split("+")[-1]
        try:
            buf = doc.extract_font(xref)[3]
            if buf:
                out.setdefault(key, []).append(pymupdf.Font(fontbuffer=buf))
        except Exception as err:  # an unreadable embedded font: the fallback draws its words (reported)
            out.setdefault("_unreadable", []).append(f"{key}: {err}")
    return out


def _words(block):
    """The block's text as words — each word a list of pieces (a word can change font
    mid-way: "(" in one font, "Registration" in another; "μ" + "g,") — with hard breaks
    kept (bullets, short lines). Pieces of one word are never separated by a space."""
    words = []
    width = block["bbox"].width
    for i, line in enumerate(block["lines"]):
        if i:
            prev = block["lines"][i - 1]
            first = line["spans"][0]["text"].lstrip()
            hard = bool(re.match(r"^[•▪›·\-–*]|^\d+[.)]\s", first)) or prev["bbox"].width < 0.6 * width
            words.append({"br": hard})
        open_word = False  # the last piece of the line so far ended without a space
        last_x1 = None
        for s in line["spans"]:
            # two runs with a visible gap between them are two words, even with no space typed
            if last_x1 is not None and s["bbox"][0] - last_x1 > 0.15 * s["size"]:
                open_word = False
            last_x1 = s["bbox"][2]
            style = {"font": s["font"], "size": s["size"], "color": s["color"], "bold": bool(s["flags"] & 16)}
            for m in re.finditer(r"\S+|\s+", s["text"]):
                frag = m.group(0)
                if frag.isspace():
                    open_word = False
                    continue
                piece = {"t": frag, **style}
                if open_word and m.start() == 0 and words and "pieces" in words[-1]:
                    words[-1]["pieces"].append(piece)  # same word, next font
                else:
                    words.append({"pieces": [piece]})
                open_word = m.end() == len(s["text"])
    return words


def _set_text(page, block, rect, factor, fonts, report, dry=False):
    """Re-wraps the block into `rect` at size × factor → used height (pt). Writes unless dry."""
    words = _words(block)
    gaps = [block["lines"][i + 1]["bbox"].y1 - block["lines"][i]["bbox"].y1 for i in range(len(block["lines"]) - 1)]
    leading = (sorted(gaps)[len(gaps) // 2] / block["size"]) if gaps else 1.2
    leading = min(max(leading, 1.0), 1.8)
    xs = [l["bbox"].x0 for l in block["lines"]]
    xe = [l["bbox"].x1 for l in block["lines"]]
    center = len(xs) > 1 and max(xs) - min(xs) > 2 and abs((max(xs) - min(xs)) - (max(xe) - min(xe))) < 3 and all(abs((a + b) / 2 - (block["bbox"].x0 + block["bbox"].x1) / 2) < 2 for a, b in zip(xs, xe))
    right = not center and len(xe) > 1 and max(xe) - min(xe) < 1 and max(xs) - min(xs) > 3
    substituted = set()

    def font_for(w):
        for f in fonts.get(w["font"].split("+")[-1], []):
            if all(f.has_glyph(ord(c)) for c in w["t"]):
                return f
        substituted.add(w["font"])
        return _fallback(w["bold"])

    # a line is a list of (piece, font, size, space before); a word's pieces stay together.
    # A bulleted item keeps its hanging indent: its wrapped lines start under its text, not the bullet.
    lines, cur, cur_w, indent, hang = [], [], 0, 0.0, 0.0
    first = True  # the next word starts an item (block start or a hard break)
    for w in words:
        if w.get("br") is not None:
            if w["br"]:
                if cur:
                    lines.append((cur, cur_w, indent))
                    cur, cur_w = [], 0
                first, indent, hang = True, 0.0, 0.0
            continue
        parts = [(p, font_for(p), p["size"] * factor) for p in w["pieces"]]
        ww = sum(f.text_length(p["t"], fontsize=sz) for p, f, sz in parts)
        sp = parts[0][1].text_length(" ", fontsize=parts[0][2]) if cur else 0
        if cur and indent + cur_w + sp + ww > rect.width + 0.01:
            lines.append((cur, cur_w, indent))
            cur, cur_w, sp, indent = [], 0, 0, hang
        for k, (p, f, sz) in enumerate(parts):
            cur.append((p, f, sz, sp if k == 0 else 0))
        cur_w += sp + ww
        if first:
            first = False
            if len(w["pieces"]) == 1 and re.fullmatch(r"[•▪›·\-–*]", w["pieces"][0]["t"]):
                hang = ww + parts[0][1].text_length(" ", fontsize=parts[0][2])
    if cur:
        lines.append((cur, cur_w, indent))
    y = rect.y0
    writers = {}
    for ln, ln_w, ind in lines:
        size = max(s for _, _, s, _ in ln)
        y += size * (leading if y > rect.y0 else 1.0)
        x = rect.x0 + (rect.width - ln_w if right else (rect.width - ln_w) / 2 if center else ind)
        for w, f, s, sp in ln:
            x += sp
            if not dry:
                tw = writers.setdefault(w["color"], pymupdf.TextWriter(page.rect))
                tw.append((x, y), w["t"], font=f, fontsize=s)
            x += f.text_length(w["t"], fontsize=s)
    used = (y - rect.y0) + (lines and max(s for _, _, s, _ in lines[-1][0]) * 0.25 or 0)
    if not dry:
        for color, tw in writers.items():
            tw.write_text(page, color=pymupdf.sRGB_to_pdf(color) if isinstance(color, int) else color)
        if substituted:
            report.setdefault("fontsSubstituted", sorted(set(report.get("fontsSubstituted", [])) | substituted))
    return used, len(lines)


# ── the layers taken from the original ───────────────────────────────────────
def _layer_docs(src, pno, groups, texts):
    """→ (background doc: no text, artwork cut out), (artwork doc: no text), (text doc: page k = text block k only)."""
    R = src[pno].rect

    def single():
        d = pymupdf.open()
        d.insert_pdf(src, from_page=pno, to_page=pno)
        return d

    art = single()
    art[0].add_redact_annot(art[0].rect)
    art[0].apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    bg = pymupdf.open()
    bg.insert_pdf(art)
    for g in groups:
        # a little wider than the group: an outline's stroke reaches past its geometric box
        bg[0].add_redact_annot(g["bbox"] + (-1.5, -1.5, 1.5, 1.5))
    if groups:
        bg[0].apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_REMOVE, graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED, text=pymupdf.PDF_REDACT_TEXT_NONE)
    txt = pymupdf.open()
    only_text = single()
    only_text[0].add_redact_annot(only_text[0].rect)
    only_text[0].apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_REMOVE, graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED, text=pymupdf.PDF_REDACT_TEXT_NONE)
    for t in texts:
        txt.insert_pdf(only_text)
        p = txt[-1]
        b = t["bbox"] + (-0.6, -0.6, 0.6, 0.6)
        # everything around the block: its text only stays
        for r in (pymupdf.Rect(R.x0, R.y0, R.x1, b.y0), pymupdf.Rect(R.x0, b.y1, R.x1, R.y1), pymupdf.Rect(R.x0, b.y0, b.x0, b.y1), pymupdf.Rect(b.x1, b.y0, R.x1, b.y1)):
            if r.width > 0 and r.height > 0:
                p.add_redact_annot(r)
        p.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    return bg, art, txt


def _legible_min(t, min_pt):
    """The smallest run of text in the block that was at or above the minimum (None: all of it was small print)."""
    sizes = [sp["size"] for l in t["lines"] for sp in l["spans"] if sp["size"] >= min_pt - 0.01]
    return min(sizes) if sizes else None


def _span_sizes(t):
    return [sp["size"] for l in t["lines"] for sp in l["spans"]]


# ── resize ───────────────────────────────────────────────────────────────────
def resize(pdf, width_mm, height_mm, page=0, min_font_pt=6.0, mode="auto", bleed_mm=0.0, crop_marks=False, overrides=None, preview_dpi=110):
    """→ { fit, mode, pdf (bytes) | None, png (bytes), report }"""
    src = pymupdf.open(stream=pdf, filetype="pdf")
    if page >= len(src):
        raise ValueError(f"the file has {len(src)} page(s)")
    sp = src[page]
    R = sp.rect
    W2, H2 = width_mm * MM, height_mm * MM
    sx, sy = W2 / R.width, H2 / R.height
    u = min(sx, sy)
    same = abs(sx / sy - 1) < SAME_RATIO_TOLERANCE
    use = "scale" if mode == "scale" or (mode == "auto" and same) else "smart"
    bleed = bleed_mm * MM
    slug = CROP_SLUG_MM * MM if crop_marks else 0.0
    b = bleed + slug  # where the label itself starts on the sheet
    out = pymupdf.open()
    np = out.new_page(width=W2 + 2 * b, height=H2 + 2 * b)
    T = pymupdf.Rect(b, b, b + W2, b + H2)  # the trim box: the label itself
    B = T + (-bleed, -bleed, bleed, bleed)  # the bleed box: the artwork runs on to here
    report = {"mode": use, "sx": round(sx, 4), "sy": round(sy, 4), "scale": round(u, 4), "minFontPt": min_font_pt, "warnings": [], "blocks": [], "overflow": [], "suggestions": []}
    sizes_out = []

    if use == "scale":
        if bleed:
            edge = pymupdf.open()
            edge.insert_pdf(src, from_page=page, to_page=page)
            edge[0].add_redact_annot(edge[0].rect)
            edge[0].apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)
            np.show_pdf_page(B, edge, 0, keep_proportion=False)
            np.draw_rect(T, color=None, fill=(1, 1, 1), overlay=True)  # the label itself is drawn exactly, over white
        # the whole design, vector-scaled (proportions kept; centred when not exactly the same ratio)
        np.show_pdf_page(T if same else pymupdf.Rect(T.x0 + (W2 - R.width * u) / 2, T.y0 + (H2 - R.height * u) / 2, T.x0 + (W2 + R.width * u) / 2, T.y0 + (H2 + R.height * u) / 2), src, page)
        for blk in sp.get_text("dict")["blocks"]:
            for l in blk.get("lines", []):
                for s in l["spans"]:
                    if s["text"].strip():
                        sizes_out.append((s["size"] * u, s["size"]))
    else:
        a = analyse(src, page)
    if use == "smart" and a["box_net"]:
        # a box net keeps its proportions: shown scaled to fit (preview only), no PDF, and the
        # two nearest sizes with the same proportions suggested
        np.show_pdf_page(pymupdf.Rect(T.x0 + (W2 - R.width * u) / 2, T.y0 + (H2 - R.height * u) / 2, T.x0 + (W2 + R.width * u) / 2, T.y0 + (H2 + R.height * u) / 2), src, page)
        report["overflow"].append({"id": "page", "role": "box_net", "text": "", "overflowMm": 0, "code": "box_net"})
        ratio = R.height / R.width
        report["suggestions"] += [
            {"widthMm": round(width_mm, 1), "heightMm": round(width_mm * ratio, 1), "why": "same proportions as the box, this width", "sameRatio": True},
            {"widthMm": round(height_mm / ratio, 1), "heightMm": round(height_mm, 1), "why": "same proportions as the box, this height", "sameRatio": True},
        ]
        report["boxNet"] = True
    elif use == "smart":
        bg, art, txt = _layer_docs(src, page, a["groups"], a["texts"])
        fonts = _fonts_of(src, sp)
        overrides = overrides or {}
        # 1. background: stretched to the whole page (with the bleed)
        np.show_pdf_page(B, bg, 0, keep_proportion=False)
        placed = []
        # 2. artwork groups: uniform scale at their anchor (with the text on them)
        for g in a["groups"]:
            C = container_of(g["bbox"], a["panels"], R)
            anc = _anchor(g["bbox"], C)
            r = _place(g["bbox"], R, W2, H2, sx, sy, u, anc, C=C) + (b, b, b, b)
            # legible text on the artwork never goes under the minimum: the group grows with it
            gtexts = [x for x in a["texts"] if x["id"] in g["texts"]]
            need = max([min_font_pt / _legible_min(x, min_font_pt) for x in gtexts if _legible_min(x, min_font_pt)] or [0])
            grown = need > r.width / g["bbox"].width + 1e-6
            if grown:
                r = _place(g["bbox"], R, W2, H2, sx, sy, u, anc, size=(g["bbox"].width * need, g["bbox"].height * need), C=C) + (b, b, b, b)
                # slid back onto the page when it now sticks out of one side
                dx = 0 if r.width > T.width else (T.x0 - r.x0 if r.x0 < T.x0 else (T.x1 - r.x1 if r.x1 > T.x1 else 0))
                dy = 0 if r.height > T.height else (T.y0 - r.y0 if r.y0 < T.y0 else (T.y1 - r.y1 if r.y1 > T.y1 else 0))
                r = r + (dx, dy, dx, dy)
            ov = overrides.get(g["id"])
            if ov and ov.get("rect"):
                r = pymupdf.Rect([v * MM for v in ov["rect"]]) + (b, b, b, b)
            np.show_pdf_page(r, art, 0, clip=g["bbox"])
            k = r.width / g["bbox"].width
            for tid in g["texts"]:
                t = next(x for x in a["texts"] if x["id"] == tid)
                tb = t["bbox"] + (-0.6, -0.6, 0.6, 0.6)  # the copy's box: the block with its padding, mapped exactly (× k)
                tr = pymupdf.Rect(r.x0 + (tb.x0 - g["bbox"].x0) * k, r.y0 + (tb.y0 - g["bbox"].y0) * k, r.x0 + (tb.x1 - g["bbox"].x0) * k, r.y0 + (tb.y1 - g["bbox"].y0) * k)
                np.show_pdf_page(tr, txt, a["texts"].index(t), clip=tb)
                sizes_out += [(z * k, z) for z in _span_sizes(t)]
            placed.append({"id": g["id"], "rect": r, "kind": "group"})
            if grown:
                out_by = max(r.y1 - T.y1, r.x1 - T.x1, T.x0 - r.x0, T.y0 - r.y0)
                if out_by > 0.5:
                    report["overflow"].append({"id": g["id"], "role": g["role"], "text": (gtexts[0]["text"] if gtexts else "")[:60], "overflowMm": mm(out_by), "code": "text_too_small", "needScale": round(need / u, 3)})
            report["blocks"].append({"id": g["id"], "role": g["role"], "anchor": anc, "rect": [mm(v - b) for v in (r.x0, r.y0, r.x1, r.y1)], "scale": round(k, 4), "texts": g["texts"]})
        # 3. text blocks: plan every block, let the ones that grew push the blocks below
        #    them down (gaps shrink before text does), then draw
        PAD = 0.6
        plan = []
        free = sorted([t for t in a["texts"] if not t.get("group")], key=lambda t: (t["bbox"].y0, t["bbox"].x0))
        # stacks: blocks that read together (one under / beside the other, close) move together —
        # a heading, its list and the list's bullets keep one anchor
        parent = list(range(len(free)))

        def root(k):
            while parent[k] != k:
                parent[k] = parent[parent[k]]
                k = parent[k]
            return k

        for i, ti in enumerate(free):
            for j in range(i + 1, len(free)):
                tj = free[j]
                gap_y = max(tj["bbox"].y0 - ti["bbox"].y1, ti["bbox"].y0 - tj["bbox"].y1)
                gap_x = max(tj["bbox"].x0 - ti["bbox"].x1, ti["bbox"].x0 - tj["bbox"].x1)
                near = max(3 * MM, 1.5 * max(ti["size"], tj["size"]))
                if gap_y < near and gap_x < near * 0.6 and container_of(ti["bbox"], a["panels"], R) == container_of(tj["bbox"], a["panels"], R):
                    parent[root(i)] = root(j)
        stacks = {}
        for k, t in enumerate(free):
            stacks.setdefault(root(k), pymupdf.Rect(t["bbox"]))
            stacks[root(k)] |= t["bbox"]
        stack_of = {t["id"]: stacks[root(k)] for k, t in enumerate(free)}
        for t in free:
            S0 = stack_of[t["id"]]
            C = container_of(S0, a["panels"], R)
            anc = _anchor(S0, C)
            S1 = _place(S0, R, W2, H2, sx, sy, u, anc, C=C)

            def in_stack(rect, size=None, S0=S0, S1=S1):
                """the member's place: the stack's, then its own offset inside it (x u)"""
                w = size[0] if size else rect.width * u
                h = size[1] if size else rect.height * u
                x0 = S1.x0 + (rect.x0 - S0.x0) * u
                y0 = S1.y0 + (rect.y0 - S0.y0) * u
                return pymupdf.Rect(x0, y0, x0 + w, y0 + h)

            ov = overrides.get(t["id"]) or {}
            factor = u
            lm = _legible_min(t, min_font_pt)
            legible = lm is not None
            if ov.get("fontPt"):
                factor = float(ov["fontPt"]) / t["size"]
                if legible and lm * factor < min_font_pt:
                    factor = min_font_pt / lm  # a size set by hand obeys the minimum too
                    report["warnings"].append({"id": t["id"], "code": "font_raised_to_min", "minFontPt": min_font_pt})
            elif legible and lm * u < min_font_pt:
                factor = min_font_pt / lm  # legible text never goes under the minimum
            # a real paragraph only: a column of bullets or numbers (a few points wide) keeps its shape
            can_wrap = not t["rotated"] and t["role"] in ("paragraph", "heading") and t["bbox"].width >= 8 * t["size"] and (len(t["lines"]) >= 2 or len(t["text"].split()) >= 4)
            # a run lying off its own panel (white on white past a band's edge: an artboard leftover)
            # would show once re-wrapped onto the panel: such a block is copied exactly instead
            # its panel: the smallest one under at least half of it
            tarea = t["bbox"].width * t["bbox"].height
            home = min((p for p in a["panels"] if (t["bbox"] & p).width * (t["bbox"] & p).height >= 0.5 * tarea), key=lambda p: p.width * p.height, default=None)
            if can_wrap and home is not None:
                can_wrap = all((pymupdf.Rect(sp["bbox"]) & home).width >= 0.5 * (sp["bbox"][2] - sp["bbox"][0]) for l in t["lines"] for sp in l["spans"])
            wrap = can_wrap and (sx > sy * 1.02 or factor > u + 1e-6 or bool(ov.get("rect")) or bool(ov.get("fontPt")))
            entry = {"id": t["id"], "role": t["role"], "anchor": anc, "stack": [mm(v) for v in (S0.x0, S0.y0, S0.x1, S0.y1)], "fontPt": round(t["size"] * factor, 2), "rewrapped": wrap, "raisedToMin": factor > u + 1e-6 and not ov.get("fontPt")}
            if wrap:
                # the block's proportional box (its share of the new width), at least its uniform size
                cw = (C.width * sx) if C != R else W2
                width = min(t["bbox"].width * max(sx, u), cw)
                box = in_stack(t["bbox"], size=(width, t["bbox"].height * u)) + (b, b, b, b)
                if ov.get("rect"):
                    box = pymupdf.Rect([v * MM for v in ov["rect"]]) + (b, b, b, b)
                else:
                    # inside its panel (a band, a box) as the stretched background drew it. The left edge
                    # stays (it lines up with the blocks above and below); the extra width stops at the
                    # panel's edge. Slid back only when even the uniform width doesn't fit there.
                    lim = T if C == R else pymupdf.Rect(C.x0 * sx, C.y0 * sy, C.x1 * sx, C.y1 * sy) + (b, b, b, b)
                    if box.x1 > lim.x1:
                        keep = t["bbox"].width * u
                        x1 = lim.x1
                        x0 = min(box.x0, max(lim.x0, x1 - keep))
                        box = pymupdf.Rect(x0, box.y0, x1, box.y1)
                box = pymupdf.Rect(max(box.x0, T.x0), box.y0, min(box.x1, T.x1), box.y1)
                need, nlines = _set_text(np, t, box, factor, fonts, report, dry=True)
                rect = pymupdf.Rect(box.x0, box.y0, box.x1, box.y0 + need)
                entry["lines"] = nlines
            else:
                size = ((t["bbox"].width + 2 * PAD) * factor, (t["bbox"].height + 2 * PAD) * factor)
                rect = in_stack(t["bbox"] + (-PAD, -PAD, PAD, PAD), size=size) + (b, b, b, b)
                if ov.get("rect"):
                    q = pymupdf.Rect([v * MM for v in ov["rect"]]) + (b, b, b, b)
                    rect = pymupdf.Rect(q.x0, q.y0, q.x0 + rect.width, q.y0 + rect.height)
            plan.append({"t": t, "rect": rect, "wrap": wrap, "factor": factor, "entry": entry, "moved": 0.0, "pinned": bool(ov.get("rect")) or t["rotated"], "C": C})
        # the flow: a block that overlaps one placed above it moves down by the overlap
        def h_overlap(r1, r2):
            # one above the other: they share at least 30 % of the narrower one's width
            return min(r1.x1, r2.x1) - max(r1.x0, r2.x0) > 0.3 * max(0.5, min(r1.width, r2.width))

        def above_below(pi, pj):
            """pj is under pi in the original (not beside it), and still shares width with it now"""
            return h_overlap(pi["t"]["bbox"], pj["t"]["bbox"]) and h_overlap(pi["rect"], pj["rect"])
        for i, pi in enumerate(plan):
            for pj in plan[i + 1 :]:
                if pj["pinned"] or not above_below(pi, pj):
                    continue
                if pj["t"]["bbox"].y0 < pi["t"]["bbox"].y0 - 0.5:
                    continue  # only what was below it in the original moves
                over = pi["rect"].y1 - pj["rect"].y0
                if over > 0 and pj["rect"].y0 >= pi["rect"].y0:
                    pj["rect"] = pj["rect"] + (0, over, 0, over)
                    pj["moved"] += over
        # artwork as placed, with the original box (text that already sat on it in the design is fine)
        group_rects = [(p["rect"], next(g["bbox"] for g in a["groups"] if g["id"] == p["id"])) for p in placed]
        for pi in plan:
            pad = 0 if pi["wrap"] else PAD * pi["factor"]  # a copied block's rect has empty padding around its text
            r = pi["rect"] + (pad, pad, -pad, -pad)
            t = pi["t"]
            # the panel it sits on (a band, a box), where the stretched background put it
            C = pi["C"]
            C1 = None if C == R else pymupdf.Rect(C.x0 * sx, C.y0 * sy, C.x1 * sx, C.y1 * sy) + (b, b, b, b)
            out_panel = C1 is not None and max(r.x1 - C1.x1, C1.x0 - r.x0, r.y1 - C1.y1, C1.y0 - r.y0) > 1 * MM
            if r.y1 > T.y1 + 0.5 or r.x1 > T.x1 + 0.5 or r.x0 < T.x0 - 0.5 or r.y0 < T.y0 - 0.5:
                ox, oy = max(r.x1 - T.x1, T.x0 - r.x0, 0), max(r.y1 - T.y1, T.y0 - r.y0, 0)
                report["overflow"].append({"id": t["id"], "role": t["role"], "text": t["text"][:60], "overflowMm": mm(max(ox, oy)), "axis": "x" if ox > oy else "y"})
            elif out_panel:
                ox, oy = max(r.x1 - C1.x1, C1.x0 - r.x0, 0), max(r.y1 - C1.y1, C1.y0 - r.y0, 0)
                report["overflow"].append({"id": t["id"], "role": t["role"], "text": t["text"][:60], "overflowMm": mm(max(ox, oy)), "axis": "x" if ox > oy else "y", "over": "panel"})
            else:
                new_hits = [min(r.y1, g.y1) - max(r.y0, g.y0) for g, g0 in group_rects if (t["bbox"] & g0).is_empty and h_overlap(r, g) and min(r.y1, g.y1) - max(r.y0, g.y0) > 0.5]
                if (pi["moved"] > 0.5 or pi["entry"]["raisedToMin"]) and new_hits:
                    report["overflow"].append({"id": t["id"], "role": t["role"], "text": t["text"][:60], "overflowMm": mm(max(new_hits)), "over": "artwork"})
        for pi in plan:
            t, r = pi["t"], pi["rect"]
            if pi["wrap"]:
                _set_text(np, t, r, pi["factor"], fonts, report)
            else:
                np.show_pdf_page(r, txt, a["texts"].index(t), clip=t["bbox"] + (-PAD, -PAD, PAD, PAD))
            sizes_out += [(z * pi["factor"], z) for z in _span_sizes(t)]
            pi["entry"]["rect"] = [mm(v - b) for v in (r.x0, r.y0, r.x1, r.y1)]
            if pi["moved"] > 0.5:
                pi["entry"]["movedDownMm"] = mm(pi["moved"])
            report["blocks"].append(pi["entry"])
        report["textBlocks"] = len(a["texts"])
        report["artworkGroups"] = len(a["groups"])

    # sizes: the smallest text, and legible text that went under the minimum
    if sizes_out:
        report["smallestFontPt"] = round(min(s for s, _ in sizes_out), 2)
        report["originalSmallestFontPt"] = round(min(o for _, o in sizes_out), 2)
        under = [s for s, o in sizes_out if s < min_font_pt - 0.01 and o >= min_font_pt]
        if under:
            report["warnings"].append({"code": "below_min", "fontPt": round(min(under), 2), "minFontPt": min_font_pt})
        if report["originalSmallestFontPt"] < min_font_pt:
            report["warnings"].append({"code": "original_below_min", "fontPt": report["originalSmallestFontPt"], "afterPt": report["smallestFontPt"], "minFontPt": min_font_pt})
    if b:
        np.set_trimbox(T)
        np.set_bleedbox(B)
        if crop_marks:
            sh = np.new_shape()
            gap = 1 * MM  # marks start 1 mm outside the bleed
            for x in (T.x0, T.x1):
                sh.draw_line((x, 0), (x, B.y0 - gap))
                sh.draw_line((x, B.y1 + gap), (x, np.rect.y1))
            for y in (T.y0, T.y1):
                sh.draw_line((0, y), (B.x0 - gap, y))
                sh.draw_line((B.x1 + gap, y), (np.rect.x1, y))
            sh.finish(color=(0, 0, 0), width=0.25)
            sh.commit()
    fit = not report["overflow"]
    if not fit and any(o.get("code") == "text_too_small" for o in report["overflow"]):
        f = max(o["needScale"] for o in report["overflow"] if o.get("code") == "text_too_small")
        report["suggestions"].append({"widthMm": math.ceil(width_mm * f / 5) * 5, "heightMm": math.ceil(height_mm * f / 5) * 5, "why": "larger, so the text on the artwork stays at the minimum size"})
    elif not fit and not report.get("boxNet"):
        ex = max([o["overflowMm"] for o in report["overflow"] if o.get("axis") == "x"] or [0])
        ey = max([o["overflowMm"] for o in report["overflow"] if o.get("axis") != "x"] or [0])
        report["suggestions"].append({
            "widthMm": math.ceil((width_mm + ex + 2) / 5) * 5 if ex else round(width_mm, 1),
            "heightMm": math.ceil((height_mm + ey + 2) / 5) * 5 if ey else round(height_mm, 1),
            "why": "larger, so every block fits at the minimum size",
        })
        long = [o for o in report["overflow"] if o["role"] in ("paragraph", "table")]
        if long:
            report["suggestions"].append({"columns": 2, "blocks": [o["id"] for o in long], "why": "set the long text in two columns"})
    png = np.get_pixmap(dpi=preview_dpi, clip=T).tobytes("png")
    data = out.tobytes(garbage=3, deflate=True) if fit else None
    report["pageMm"] = {"width": round(width_mm, 2), "height": round(height_mm, 2), "bleed": bleed_mm, "cropMarks": bool(crop_marks), "sheetWidth": mm(np.rect.width), "sheetHeight": mm(np.rect.height)}
    return {"fit": fit, "mode": use, "pdf": data, "png": png, "report": report}


def preview_original(pdf, page=0, dpi=110):
    src = pymupdf.open(stream=pdf, filetype="pdf")
    p = src[page]
    return p.get_pixmap(dpi=dpi).tobytes("png"), {"widthMm": mm(p.rect.width), "heightMm": mm(p.rect.height), "pages": len(src)}


def describe(pdf, page=0):
    """The blocks the editor shows (ids, roles, anchors, original rects in mm)."""
    src = pymupdf.open(stream=pdf, filetype="pdf")
    a = analyse(src, page)
    R = a["rect"]
    return {
        "pageMm": {"width": mm(R.width), "height": mm(R.height)},
        "pages": len(src),
        "boxNet": a["box_net"],
        "blocks": [{"id": t["id"], "role": t["role"], "text": t["text"][:80], "fontPt": round(t["size"], 2), "rect": [mm(v) for v in (t["bbox"].x0, t["bbox"].y0, t["bbox"].x1, t["bbox"].y1)], "group": t.get("group")} for t in a["texts"]]
        + [{"id": g["id"], "role": g["role"], "rect": [mm(v) for v in (g["bbox"].x0, g["bbox"].y0, g["bbox"].x1, g["bbox"].y1)], "texts": g["texts"]} for g in a["groups"]],
    }
