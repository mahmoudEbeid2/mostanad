// Regenerates assets/cert-fonts/manifest.json: which file is which face, and which
// characters each face can draw. Run it after changing the fonts: node scripts/buildCertFontManifest.js
import fs from "fs";
import path from "path";
import fontkit from "@pdf-lib/fontkit";

const DIR = path.resolve("assets/cert-fonts");
const families = [
  ["Liberation Sans", "sans", "LiberationSans"],
  ["Liberation Serif", "serif", "LiberationSerif"],
  ["Liberation Mono", "mono", "LiberationMono"],
  ["Carlito", "sans", "Carlito"],
  ["Caladea", "serif", "Caladea"],
  ["Noto Sans", "sans", "NotoSans"],
  ["Noto Serif", "serif", "NotoSerif"],
  ["Noto Sans Arabic", "sans", "NotoSansArabic"],
  ["Noto Sans Symbols 2", "sans", "NotoSansSymbols2"],
];
const FACES = [
  ["Regular", 400, "normal"],
  ["Bold", 700, "normal"],
  ["Italic", 400, "italic"],
  ["BoldItalic", 700, "italic"],
];

function ranges(codePoints) {
  const out = [];
  for (const cp of [...codePoints].filter((c) => c > 0x1f).sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && cp === last[1] + 1) last[1] = cp;
    else if (!last || cp !== last[1]) out.push([cp, cp]);
  }
  return out;
}

const manifest = { families: {} };
for (const [name, generic, stem] of families) {
  const faces = [];
  for (const [suffix, weight, style] of FACES) {
    const file = `${stem}-${suffix}.ttf`;
    if (!fs.existsSync(path.join(DIR, file))) continue;
    const font = fontkit.create(fs.readFileSync(path.join(DIR, file)));
    faces.push({ file, weight, style, coverage: ranges(font.characterSet) });
  }
  if (!faces.length) throw new Error(`No file for ${name}`);
  manifest.families[name] = { generic, faces };
}
fs.writeFileSync(path.join(DIR, "manifest.json"), `${JSON.stringify(manifest)}\n`);
console.log(Object.entries(manifest.families).map(([n, f]) => `${n}: ${f.faces.length} faces`).join("\n"));
