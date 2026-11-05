import fs from "fs";

// The fonts shipped for characters a design's subset font lacks (assets/cert-fonts).
// No browser and no fontkit here: the API, the workers and the renderer all read it.
// Each face's coverage lives in manifest.json, so it is one fact per font file, not
// one copy per template version.

const FONT_DIR = new URL("../../../../assets/cert-fonts/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", FONT_DIR), "utf8"));

/** Tried after the font matched to the design font, in this order. */
export const FALLBACK_CHAIN = ["Noto Sans", "Noto Sans Symbols 2", "Noto Sans Arabic"];

export const FALLBACK_FAMILIES = Object.keys(manifest.families);

export const isFallbackFamily = (family) => Object.prototype.hasOwnProperty.call(manifest.families, family);

/** The family's face closest to the design font: a family without that weight or style gives its nearest. */
export function pickFace(family, weight = 400, style = "normal") {
  const faces = manifest.families[family]?.faces || [];
  const bold = weight >= 600;
  const score = (f) => (f.weight >= 600 === bold ? 2 : 0) + (f.style === style ? 1 : 0);
  return faces.reduce((best, f) => (!best || score(f) > score(best) ? f : best), null);
}

/** "Liberation Sans Bold": the name shown to people, and the CSS family of that one face. */
export function faceName(family, face) {
  const suffix = [face.weight >= 600 ? "Bold" : "", face.style === "italic" ? "Italic" : ""].filter(Boolean).join(" ");
  return suffix ? `${family} ${suffix}` : family;
}

function covers(face, ch) {
  const cp = ch.codePointAt(0);
  let lo = 0;
  let hi = face.coverage.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to] = face.coverage[mid];
    if (cp < from) hi = mid - 1;
    else if (cp > to) lo = mid + 1;
    else return true;
  }
  return false;
}

/** The fonts tried for one design font, matched font first → [{ family, face, name }]. */
export function fallbackFaces(entry) {
  if (!entry?.fallbackFamily || !isFallbackFamily(entry.fallbackFamily)) return [];
  const families = [...new Set([entry.fallbackFamily, ...FALLBACK_CHAIN])];
  return families.map((family) => {
    const face = pickFace(family, entry.weight, entry.style);
    return { family, face, name: faceName(family, face) };
  });
}

/** The first font that can draw `ch` for this design font, or null. */
export const faceFor = (entry, ch) => fallbackFaces(entry).find((f) => covers(f.face, ch)) || null;

export const readFontFile = (file) => fs.readFileSync(new URL(file, FONT_DIR));

/**
 * Which font drew each glyph_fallback character → { [key]: { "+": "Noto Sans" } }.
 * `classes` is { [key]: [fontClass…] }; a group key lists the classes of its cells.
 */
export function fallbackFontNames(flags, classes, fontFallbacks) {
  const out = {};
  for (const [key, list] of Object.entries(flags || {})) {
    for (const flag of list || []) {
      if (!String(flag).startsWith("glyph_fallback:")) continue;
      for (const ch of Array.from(String(flag).slice("glyph_fallback:".length))) {
        const name = (classes[key] || []).map((c) => faceFor(fontFallbacks?.[c], ch)?.name).find(Boolean);
        if (name) (out[key] ??= {})[ch] = name;
      }
    }
  }
  return out;
}
