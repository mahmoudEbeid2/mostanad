import { faceFor, fallbackFaces } from "./fallbackFonts.js";
import { lookAlikeFor } from "./glyphLookAlikes.js";

// Decides, before a document is filled, what happens to each value character a design
// font lacks. The field engine in the page only applies the result, so the rules stay
// in Node with the fonts, where they can be tested without a browser.

function usedCharacters(values, defs, groups) {
  const used = new Map();
  const add = (fontClass, value) => {
    if (!fontClass || value === null || value === undefined) return;
    if (!used.has(fontClass)) used.set(fontClass, new Set());
    for (const ch of Array.from(String(value))) used.get(fontClass).add(ch);
  };
  for (const def of defs || []) add(def.fontClass, values?.[def.key]);
  for (const g of groups || []) {
    const rows = Array.isArray(values?.[g.key]) ? values[g.key] : [];
    for (const row of rows) for (const cell of g.cells || []) add(cell.fontClass, row?.[cell.key]);
    if (!rows.length) add(g.cells?.[0]?.fontClass, "—"); // what an empty group prints
  }
  return used;
}

/**
 * → { classes: { [fontClass]: { subs: { ch: alt }, fallback: { ch: faceName }, stack } },
 *     faces: [{ name, file, chars }] }, or null when no value needs either.
 * A character with neither stays out of both maps: the engine flags it glyph:…
 * A font with no entry in fontFallbacks (not matched yet) gets look-alikes only, and a
 * font with unknown coverage gets nothing: whether it lacks a character can't be known.
 */
export function planGlyphs({ values, defs, groups = [], fontCoverage, fontFallbacks }) {
  const classes = {};
  const faces = new Map();
  for (const [fontClass, chars] of usedCharacters(values, defs, groups)) {
    const coverage = fontCoverage?.[fontClass];
    if (typeof coverage !== "string") continue;
    const covered = new Set(Array.from(coverage));
    const entry = fontFallbacks?.[fontClass];
    const subs = {};
    const fallback = {};
    for (const ch of chars) {
      if (covered.has(ch)) continue;
      const alt = lookAlikeFor(ch, covered);
      if (alt) {
        subs[ch] = alt;
        continue;
      }
      if (/\s/.test(ch)) continue;
      const drawn = faceFor(entry, ch);
      if (!drawn) continue;
      fallback[ch] = drawn.name;
      if (!faces.has(drawn.name)) faces.set(drawn.name, { name: drawn.name, file: drawn.face.file, chars: new Set() });
      faces.get(drawn.name).chars.add(ch);
    }
    if (!Object.keys(subs).length && !Object.keys(fallback).length) continue;
    const names = new Set(Object.values(fallback));
    const order = fallbackFaces(entry).filter((f) => names.has(f.name)).map((f) => `"${f.name}"`);
    classes[fontClass] = { subs, fallback, stack: [`"${fontClass}"`, ...order, "sans-serif"].join(", ") };
  }
  if (!Object.keys(classes).length) return null;
  return { classes, faces: [...faces.values()].map((f) => ({ ...f, chars: [...f.chars].join("") })) };
}
