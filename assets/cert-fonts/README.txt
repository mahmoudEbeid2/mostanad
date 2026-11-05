Fallback fonts for certificates. A value can need a character the design's subset
font lacks; the renderer then draws only that character from one of these.

They are loaded by the renderer as data: @font-face rules, subset to the characters
used. They are deliberately NOT installed as system fonts: that could change what
`sans-serif` resolves to, and with it existing renders.

All are SIL Open Font License 1.1, see licences/. OFL allows embedding in documents.
Liberation 2.1.5    github.com/liberationfonts/liberation-fonts
Carlito, Caladea    github.com/google/fonts (ofl/carlito, ofl/caladea)
Noto Sans, Serif, Sans Arabic, Sans Symbols 2    github.com/notofonts/notofonts.github.io

manifest.json is generated: node scripts/buildCertFontManifest.js
