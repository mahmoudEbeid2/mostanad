import subsetFont from "subset-font";
import { readFontFile } from "./fallbackFonts.js";

// @font-face rules for the fallback faces a certificate uses. They are subset to the
// characters used, so a stored certificate grows by a few KB, not by a whole font.
// data: sources because the renderer blocks every other URL, and because the rendered
// HTML is stored and printed later, away from these files.

const MAX_CACHED = 64;
const cache = new Map(); // a batch asks for the same few characters again and again

async function fontData(file, chars, companyFontData) {
  // a company's own font (fonts/companyFontService.js): its bytes come with the render
  const full = String(file).startsWith("company:") ? Buffer.from(companyFontData?.[file.slice(8)] || "", "base64") : readFontFile(file);
  if (!full.length) throw new Error(`the bytes of ${file} were not sent with the render`);
  try {
    return { data: await subsetFont(full, chars, { targetFormat: "truetype" }), subset: true };
  } catch (err) {
    console.warn(`[cert-renderer] embedding all of ${file}, subsetting failed: ${err.message}`);
    return { data: full, subset: false };
  }
}

/** faces: [{ name, file, chars }] from planGlyphs → the CSS text. companyFontData: { [fontId]: base64 } */
export async function fallbackFontCss(faces, { companyFontData = null } = {}) {
  const rules = [];
  for (const { name, file, chars } of faces) {
    const key = `${file}\n${[...chars].sort().join("")}`;
    if (!cache.has(key)) {
      if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
      const { data } = await fontData(file, chars, companyFontData);
      cache.set(key, Buffer.from(data).toString("base64"));
    }
    rules.push(`@font-face{font-family:"${name}";src:url(data:font/ttf;base64,${cache.get(key)}) format("truetype")}`);
  }
  return rules.join("\n");
}
