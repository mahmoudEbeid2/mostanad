import fontkit from "@pdf-lib/fontkit";

// Characters each embedded font can render (plan §7.2). pdf2htmlEX embeds
// SUBSET fonts that only contain the glyphs the design used (ADDVET's regular
// font lacks B X j x), so a filled value can need a glyph the font lacks —
// fill() flags it as `glyph:…`.
const FONT_FACE_RE = /@font-face\s*\{([^}]*)\}/gi;
const FAMILY_RE = /font-family\s*:\s*['"]?([\w-]+)['"]?/i;
const DATA_SRC_RE = /url\(\s*['"]?data:([^;,]+)?(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)['"]?\s*\)/i;

/**
 * → { [fontFamily]: "…covered characters…" } for every @font-face with a
 * base64 data: source. A font fontkit cannot parse maps to null (coverage
 * unknown → the glyph check is skipped for it, never guessed).
 */
export function computeFontCoverage(html) {
  const coverage = {};
  for (const [, body] of String(html).matchAll(FONT_FACE_RE)) {
    const family = body.match(FAMILY_RE)?.[1];
    const src = body.match(DATA_SRC_RE);
    if (!family || !src) continue;
    try {
      const font = fontkit.create(Buffer.from(src[2].replace(/\s+/g, ""), "base64"));
      const chars = (font.characterSet || [])
        .filter((cp) => cp > 0x1f && !(cp >= 0xe000 && cp <= 0xf8ff))
        .sort((a, b) => a - b)
        .map((cp) => String.fromCodePoint(cp));
      coverage[family] = chars.join("");
    } catch (_) {
      coverage[family] = null; // reported by fontWarnings(), flagged glyph_unknown at fill time
    }
  }
  return coverage;
}

/** Conversion warnings for the fonts computeFontCoverage could not parse (review #7). */
export const fontWarnings = (coverage) =>
  Object.entries(coverage || {})
    .filter(([, chars]) => chars === null)
    .map(([family]) => `FONT_UNREADABLE: the embedded font "${family}" could not be parsed — characters it lacks can't be detected; values in it are flagged glyph_unknown`);
