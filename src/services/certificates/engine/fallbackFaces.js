import subsetFont from "subset-font";
import { readFontFile } from "./fallbackFonts.js";

// @font-face rules for the fallback faces a certificate uses. They are subset to the
// characters used, so a stored certificate grows by a few KB, not by a whole font.
// data: sources because the renderer blocks every other URL, and because the rendered
// HTML is stored and printed later, away from these files.

const MAX_CACHED = 64;
const cache = new Map(); // a batch asks for the same few characters again and again

async function fontData(file, chars) {
  const full = readFontFile(file);
  try {
    return { data: await subsetFont(full, chars, { targetFormat: "truetype" }), subset: true };
  } catch (err) {
    console.warn(`[cert-renderer] embedding all of ${file}, subsetting failed: ${err.message}`);
    return { data: full, subset: false };
  }
}

/** faces: [{ name, file, chars }] from planGlyphs → the CSS text. */
export async function fallbackFontCss(faces) {
  const rules = [];
  for (const { name, file, chars } of faces) {
    const key = `${file}\n${[...chars].sort().join("")}`;
    if (!cache.has(key)) {
      if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
      const { data } = await fontData(file, chars);
      cache.set(key, Buffer.from(data).toString("base64"));
    }
    rules.push(`@font-face{font-family:"${name}";src:url(data:font/ttf;base64,${cache.get(key)}) format("truetype")}`);
  }
  return rules.join("\n");
}
