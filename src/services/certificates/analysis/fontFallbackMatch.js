import fontkit from "@pdf-lib/fontkit";
import { fontFaces } from "./fontCoverage.js";

// Picks, for each font embedded in a design, the shipped font closest to it. The real
// font is only known by its PDF name and OS/2 table, so this is name rules, in order.

const NAME_RULES = [
  [/arial|helvetica|arimo|liberationsans/, "Liberation Sans"],
  [/timesnewroman|^times|tinos|liberationserif/, "Liberation Serif"],
  [/courier|cousine|liberationmono/, "Liberation Mono"],
  [/calibri|carlito/, "Carlito"],
  [/cambria|caladea/, "Caladea"],
  [/tahoma|verdana|segoe/, "Noto Sans"],
];
const ARABIC_NAME = /arab|naskh|kufi|amiri|tajawal/;
const ARABIC_CHAR = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const MONO_NAME = /mono|consol|typewriter/;
const SERIF_NAME = /serif|garamond|georgia|palatino|minion|baskerville|bodoni|didot|antiqua|merriweather|playfair|slab|century(?!gothic)/;

/** The PDF name without its subset prefix: "ABCDEF+Arial-BoldMT" → "Arial-BoldMT". */
export const cleanFontName = (name) => String(name || "").replace(/^[A-Z]{6}\+/, "");

function looksSerif(norm, { panose, familyClass }) {
  if (/sans/.test(norm)) return false;
  if (SERIF_NAME.test(norm)) return true;
  if ([1, 2, 3, 4, 5, 7].includes((familyClass || 0) >> 8)) return true;
  // Panose for Latin text: 2–10 are serif styles, 11 and up are sans
  return panose?.[0] === 2 && panose[1] >= 2 && panose[1] <= 10;
}

function weightOf(norm, os2Weight) {
  if (/black|heavy|extrabold|ultrabold/.test(norm)) return 800;
  if (/semibold|demi/.test(norm)) return 600;
  if (/bold/.test(norm)) return 700;
  if (/thin|hairline|light/.test(norm)) return 300;
  return os2Weight || 400;
}

/** name + what the font's tables say → { fallbackFamily, weight, style }. */
export function matchFallback(name, { os2Weight = null, italic = false, panose = null, familyClass = 0, chars = "" } = {}) {
  const norm = cleanFontName(name).toLowerCase().replace(/[\s_-]+/g, "");
  const weight = weightOf(norm, os2Weight);
  const style = italic || /italic|oblique/.test(norm) ? "italic" : "normal";
  const letters = Array.from(chars).filter((c) => /\p{L}/u.test(c));
  const arabic = letters.filter((c) => ARABIC_CHAR.test(c)).length;
  if (ARABIC_NAME.test(norm) || (letters.length && arabic * 2 >= letters.length)) return { fallbackFamily: "Noto Sans Arabic", weight, style };
  const named = NAME_RULES.find(([re]) => re.test(norm));
  if (named) return { fallbackFamily: named[1], weight, style };
  if (MONO_NAME.test(norm)) return { fallbackFamily: "Liberation Mono", weight, style };
  return { fallbackFamily: looksSerif(norm, { panose, familyClass }) ? "Noto Serif" : "Noto Sans", weight, style };
}

/**
 * → { [fontFamily]: { pdfName, fallbackFamily, weight, style, source } } for every embedded
 * font. An unreadable font has no name to go by; its coverage is unknown too, so nothing is
 * drawn from the fallback (glyph_unknown stays).
 */
export function computeFontFallbacks(html) {
  const out = {};
  for (const { family, data } of fontFaces(html)) {
    try {
      const font = fontkit.create(data);
      const os2 = font["OS/2"] || {};
      const name = font.postscriptName || font.fullName || font.familyName || "";
      const chars = (font.characterSet || []).map((cp) => String.fromCodePoint(cp)).join("");
      const italic = Boolean(font.italicAngle) || Boolean(os2.fsSelection?.italic);
      out[family] = {
        pdfName: cleanFontName(name) || null,
        ...matchFallback(name, { os2Weight: os2.usWeightClass, italic, panose: os2.panose, familyClass: os2.sFamilyClass, chars }),
        source: "auto",
      };
    } catch (_) {
      out[family] = { pdfName: null, fallbackFamily: "Noto Sans", weight: 400, style: "normal", source: "auto" };
    }
  }
  return out;
}
