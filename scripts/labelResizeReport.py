"""Acceptance report for the label resize that keeps the design (docker/label-resizer).

  python scripts/labelResizeReport.py [fixtures folder] [report folder]

Default fixtures: LABEL_FIXTURES or "C:/Users/A Store/Desktop/New folder" — every
label .pdf / .ai there except catalogues and certificates. Each one at five sizes:
one with the same proportions and four that change them (taller, wider, shorter,
narrower). Per result:
  words    — the text layer's words (Unicode NFKC, soft hyphen = "-") equal the original's: 0 missing, 0 extra
  numbers  — every word with a digit, and every unit word, the same
  minimum  — no text under the minimum that wasn't under it in the original
             (same proportions: a warning, as the plain scale is allowed to shrink)
  page     — every word inside the label (trim box)
  images   — every placed image keeps its aspect within 0.5 % (a background photo
             under the whole page stretches with the bands: listed, not failed)
  colours  — the original's main colours (≥ 3 % of the page) are still there
  picture  — original and result side by side, same mm scale → <report>/<label>/<size>.png
A size that doesn't fit gives no PDF: it is reported with its reason and the suggested size.
Writes report.md and report.json in the report folder (default reports/label-resize). Exit 1 if a check failed.
"""

import collections
import json
import math
import os
import re
import sys
import time
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "docker", "label-resizer"))
import pymupdf  # noqa: E402
import resizer  # noqa: E402

MM = resizer.MM
MIN_PT = 6.0
UNITS = {"mg", "g", "kg", "ml", "mL", "l", "L", "IU", "%", "μg", "mcg", "litre", "litres", "liter", "liters", "days", "day", "cm", "mm"}
SKIP = re.compile(r"catalogue|catalog|coa|coc|hc oman|brn\d|fscav|madadd\d", re.I)


def norm(w):
    return unicodedata.normalize("NFKC", w.replace("\xad", "-"))


def words(page, clip=None):
    return collections.Counter(norm(w[4]) for w in page.get_text("words", clip=clip))


def spans(page):
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                if s["text"].strip():
                    yield s


def small_words(page, under):
    return collections.Counter(norm(w) for s in spans(page) if s["size"] < under - 0.01 for w in s["text"].split())


def colours(page, dpi=24):
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB, alpha=False)
    c = collections.Counter()
    n = pix.width * pix.height
    s = pix.samples
    for i in range(0, len(s), 3):
        c[(s[i] >> 5, s[i + 1] >> 5, s[i + 2] >> 5)] += 1
    return {k: v / n for k, v in c.items()}


def images(page):
    out = []
    for im in page.get_image_info(hashes=True):
        r = pymupdf.Rect(im["bbox"])
        if r.width > 1 and r.height > 1:
            out.append({"digest": im["digest"].hex() if im.get("digest") else None, "aspect": r.width / r.height, "area": r.width * r.height})
    return out


def side_by_side(orig_pdf, page_no, result_pdf, path, caption):
    a = pymupdf.open(stream=orig_pdf, filetype="pdf")[page_no]
    b = pymupdf.open(stream=result_pdf, filetype="pdf")[0]
    gap, head = 12 * MM, 10 * MM
    W = a.rect.width + gap + b.rect.width
    H = max(a.rect.height, b.rect.height) + head
    sheet = pymupdf.open()
    p = sheet.new_page(width=W, height=H)
    p.draw_rect(p.rect, color=None, fill=(0.93, 0.93, 0.93))
    p.show_pdf_page(pymupdf.Rect(0, head, a.rect.width, head + a.rect.height), a.parent, page_no)
    p.show_pdf_page(pymupdf.Rect(a.rect.width + gap, head, W, head + b.rect.height), b.parent, 0)
    p.insert_text((4, head - 8), caption, fontsize=max(8, min(16, W / 90)))
    dpi = max(30, min(90, int(2600 / (W / 72))))  # ~2600 px wide at most
    p.get_pixmap(dpi=dpi).save(path)


def check(orig_pdf, page_no, r, same):
    o = pymupdf.open(stream=orig_pdf, filetype="pdf")[page_no]
    g = pymupdf.open(stream=r["pdf"], filetype="pdf")[0]
    T = g.trimbox
    res = {}
    wo, wg = words(o), words(g)
    missing, extra = wo - wg, wg - wo
    res["words"] = {"ok": not missing and not extra, "missing": dict(list(missing.items())[:10]), "extra": dict(list(extra.items())[:10]), "count": sum(wo.values())}
    num = lambda c: collections.Counter({k: v for k, v in c.items() if re.search(r"\d", k) or k.strip(".,;:()") in UNITS})
    res["numbers"] = {"ok": num(wo) == num(wg), "count": sum(num(wo).values())}
    # under the minimum: only what already was (after a re-arrangement); after a plain scale, a warning
    new_small = small_words(g, MIN_PT) - small_words(o, MIN_PT)
    res["minimum"] = {"ok": same or not new_small, "warning": bool(new_small) and same, "words": dict(list(new_small.items())[:8]), "smallestPt": min([s["size"] for s in spans(g)] or [0])}
    outside = [w[4] for w in g.get_text("words") if not (pymupdf.Rect(w[:4]) & T) or w[0] < T.x0 - 0.5 or w[2] > T.x1 + 0.5 or w[1] < T.y0 - 0.5 or w[3] > T.y1 + 0.5]
    res["page"] = {"ok": not outside, "outside": outside[:8]}
    oi = {i["digest"]: i for i in images(o) if i["digest"]}
    bad, bg = [], []
    page_area = g.rect.width * g.rect.height
    for i in images(g):
        src = oi.get(i["digest"])
        if not src:
            continue
        dev = abs(i["aspect"] / src["aspect"] - 1)
        if dev > 0.005:
            (bg if i["area"] > 0.35 * page_area else bad).append(round(dev * 100, 2))
    res["images"] = {"ok": not bad, "distortedPct": bad, "backgroundStretchedPct": bg}
    co, cg = colours(o), colours(g)
    main = {k: v for k, v in co.items() if v >= 0.03}
    lost = [k for k, v in main.items() if cg.get(k, 0) < 0.3 * v]
    res["colours"] = {"ok": not lost, "main": len(main), "lost": [tuple(x * 32 for x in k) for k in lost]}
    return res


def sizes_for(Wmm, Hmm):
    r1 = lambda v: round(v, 1)
    return [
        ("same", r1(Wmm * 0.6), r1(Hmm * 0.6)),
        ("taller", r1(Wmm), r1(Hmm * 1.15)),
        ("wider", r1(Wmm * 1.12), r1(Hmm)),
        ("shorter", r1(Wmm), r1(Hmm * 0.85)),
        ("narrower", r1(Wmm * 0.85), r1(Hmm)),
    ]


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("LABEL_FIXTURES", "C:/Users/A Store/Desktop/New folder")
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "reports", "label-resize")
    if not os.path.isdir(src):
        print(f"no fixtures at {src}: skipped")
        return 0
    os.makedirs(out, exist_ok=True)
    files = sorted(f for f in os.listdir(src) if f.lower().endswith((".pdf", ".ai")) and not SKIP.search(f))
    rows, failed = [], 0
    for f in files:
        data = open(os.path.join(src, f), "rb").read()
        doc = pymupdf.open(stream=data, filetype="pdf")
        R = doc[0].rect
        slug = re.sub(r"[^\w.-]+", "_", f).strip("_")
        os.makedirs(os.path.join(out, slug), exist_ok=True)
        for name, w, h in sizes_for(R.width / MM, R.height / MM):
            t0 = time.time()
            r = resizer.resize(data, w, h, min_font_pt=MIN_PT)
            ms = int((time.time() - t0) * 1000)
            row = {"file": f, "size": name, "widthMm": w, "heightMm": h, "mode": r["mode"], "fit": r["fit"], "ms": ms,
                   "smallestPt": r["report"].get("smallestFontPt"), "originalSmallestPt": r["report"].get("originalSmallestFontPt"),
                   "rewrapped": sum(1 for b in r["report"]["blocks"] if b.get("rewrapped")), "raisedToMin": sum(1 for b in r["report"]["blocks"] if b.get("raisedToMin")),
                   "fontsSubstituted": r["report"].get("fontsSubstituted") or [], "overflow": r["report"]["overflow"], "suggestions": r["report"]["suggestions"]}
            pic = os.path.join(slug, f"{name}-{w:g}x{h:g}.png")
            if r["fit"]:
                row["checks"] = check(data, 0, r, name == "same")
                row["ok"] = all(c["ok"] for c in row["checks"].values())
                side_by_side(data, 0, r["pdf"], os.path.join(out, pic), f"{f}   original {R.width / MM:.0f} x {R.height / MM:.0f} mm   ->   {name} {w:g} x {h:g} mm ({r['mode']})")
            else:
                row["ok"] = None  # doesn't fit: no PDF (by design) — reported, not a failed check
                sheet = pymupdf.open()
                p = sheet.new_page(width=w * MM, height=h * MM)
                p.insert_image(p.rect, stream=r["png"])
                side_by_side(data, 0, sheet.tobytes(), os.path.join(out, pic), f"{f} -> {name} {w:g} x {h:g} mm: DOESN'T FIT (preview only, no PDF)")
            row["picture"] = pic.replace(os.sep, "/")
            failed += row["ok"] is False
            rows.append(row)
            mark = "PASS" if row["ok"] else ("NO FIT" if row["ok"] is None else "FAIL")
            bad = [k for k, c in row.get("checks", {}).items() if not c["ok"]]
            print(f"{mark:6} {f[:32]:32} {name:8} {w:g}x{h:g} {r['mode']:5} {ms}ms {'' if not bad else bad}", flush=True)
    json.dump(rows, open(os.path.join(out, "report.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1, default=str)
    with open(os.path.join(out, "report.md"), "w", encoding="utf8") as md:
        md.write(f"# Label resize — fixture report\n\n{len(files)} files × 5 sizes · minimum {MIN_PT} pt · {time.strftime('%Y-%m-%d %H:%M')}\n\n")
        md.write("| file | size | mm | how | result | words | numbers | min | page | images | colours | smallest pt | re-wrapped | raised | picture |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n")
        for r in rows:
            c = r.get("checks", {})
            tick = lambda k: "" if k not in c else ("✓" if c[k]["ok"] and not c[k].get("warning") else ("⚠" if c[k]["ok"] else "✗"))
            res = "pass" if r["ok"] else ("doesn't fit → " + ", ".join(f"{s['widthMm']}×{s['heightMm']}" for s in r["suggestions"] if "widthMm" in s) if r["ok"] is None else "FAIL")
            md.write(f"| {r['file']} | {r['size']} | {r['widthMm']:g}×{r['heightMm']:g} | {r['mode']} | {res} | {tick('words')} | {tick('numbers')} | {tick('minimum')} | {tick('page')} | {tick('images')} | {tick('colours')} | {r['smallestPt']} (orig {r['originalSmallestPt']}) | {r['rewrapped']} | {r['raisedToMin']} | [png]({r['picture']}) |\n")
        md.write("\n✓ pass · ⚠ same proportions: text under the minimum after the plain scale (warned in the app) · ✗ failed\n")
        need = [r for r in rows if r["ok"] is not True or r["fontsSubstituted"] or any(c.get("backgroundStretchedPct") for c in r.get("checks", {}).values())]
        if need:
            md.write("\n## Needs a look\n\n")
            for r in need:
                why = []
                if r["ok"] is None:
                    why.append("doesn't fit at the minimum size: " + "; ".join(f"{o['id']} ({o['role']}, «{o['text'][:40]}») {o['overflowMm']} mm" for o in r["overflow"][:3]))
                for k, c in r.get("checks", {}).items():
                    if not c["ok"]:
                        why.append(f"{k}: {json.dumps({x: y for x, y in c.items() if x != 'ok'}, ensure_ascii=False)}")
                if r["fontsSubstituted"]:
                    why.append("re-set text used a stand-in font (the file's font lacks glyphs or isn't embedded): " + ", ".join(r["fontsSubstituted"]))
                bg = r.get("checks", {}).get("images", {}).get("backgroundStretchedPct")
                if bg:
                    why.append(f"a background picture under the whole page stretches with it ({bg} %)")
                md.write(f"- **{r['file']} · {r['size']} {r['widthMm']:g}×{r['heightMm']:g}** — " + " · ".join(why) + "\n")
    print(f"\n{len(rows)} results, {failed} failed checks -> {os.path.abspath(out)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
