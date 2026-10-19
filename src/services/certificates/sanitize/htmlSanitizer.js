import sanitizeHtml from "sanitize-html";

// Allowlist sanitizer for every template HTML we store (CERTIFICATES_V2_PLAN.md
// §8.1, §14). Input is untrusted: pdf2htmlEX output or a user-uploaded .html.
// Output contains no script, no event handler, no remote URL, no form/iframe.
// Any change to these lists must be justified in the plan (§8.1).

const SVG_TAGS = [
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "defs", "clippath", "lineargradient", "radialgradient", "stop", "mask", "pattern", "image", "symbol",
];

const SVG_ATTRS = [
  "d", "fill", "stroke", "transform", "viewbox", "x", "y", "cx", "cy", "r", "rx", "ry",
  "x1", "y1", "x2", "y2", "points", "offset", "stop-color", "stop-opacity", "stroke-width",
  "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "clip-rule", "clip-path", "mask",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "gradientunits", "gradienttransform", "patternunits", "patterntransform", "preserveaspectratio",
  "xmlns", "version", "fx", "fy", "spreadmethod", "maskunits", "clippathunits",
];

export const ALLOWED_TAGS = ["html", "head", "body", "title", "meta", "style", "div", "span", "img", "br", "p", "a", ...SVG_TAGS];

const GLOBAL_ATTRS = ["class", "id", "style", "data-*", "width", "height", "alt", "title", "lang", "dir"];

// ── CSS ──────────────────────────────────────────────────────────────────────
// Keeps only data: URLs, drops @import, and removes legacy script-capable CSS
// (expression(), behavior, -moz-binding, javascript:). Every "<" is escaped
// (\3c): a <style> inside <svg> is parsed as foreign content, where raw markup
// in the CSS would become live elements (mXSS). No legitimate CSS needs it.
//
// CSS escapes are decoded first (review #3): `u\72 l(…)`, `@\69mport` and
// `\75\72\6c(…)` ARE url() / @import to a browser, so the checks must see them
// that way. Only escapes that stand for a LETTER or "-" are decoded — every
// character needed to spell a dangerous name — and decoding those never
// changes what the CSS means. Escaped quotes, backslashes, digits and "<" stay
// as written.
const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gis;
const CSS_ESCAPE_RE = /\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|([^0-9a-f\r\n\f]))/gi;
// functions whose STRING arguments are URLs the browser fetches (url() itself is URL_RE)
const URL_STRING_FUNCTIONS = /(^|[^\w-])((?:-webkit-)?image-set|image|(?:-webkit-)?cross-fade|src)\(/gi;
const QUOTED_RE = /(["'])((?:\\.|(?!\1)[^\\])*)\1/g;

const isDataUrl = (v) => /^\s*data:/i.test(v || "");

export function decodeCssIdentEscapes(css) {
  return String(css).replace(CSS_ESCAPE_RE, (m, hex, ch) => {
    const c = hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : ch;
    return /^[a-z-]$/i.test(c) ? c : m;
  });
}

/** Index just past the ")" closing the "(" at `open` (quotes respected), or -1. */
function closingParen(css, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/** image-set("https://…" 1x), image("…"), cross-fade(…), src("…"): every non-data: string → "data:,". */
function neutraliseUrlStrings(css) {
  let out = "";
  let last = 0;
  for (const m of css.matchAll(URL_STRING_FUNCTIONS)) {
    const open = m.index + m[0].length - 1;
    if (open < last) continue; // inside a function already rewritten
    const end = closingParen(css, open);
    if (end < 0) {
      // unterminated — drop the rest rather than guess where it ends
      out += css.slice(last, m.index + m[1].length);
      return out;
    }
    out += css.slice(last, open) + css.slice(open, end).replace(QUOTED_RE, (s, _q, v) => (isDataUrl(v) ? s : '"data:,"'));
    last = end;
  }
  return out + css.slice(last);
}

export function sanitizeCss(css) {
  if (!css) return css;
  return neutraliseUrlStrings(decodeCssIdentEscapes(String(css).replace(/</g, "\\3c ")))
    .replace(/@import[^;]*;?/gi, "")
    .replace(URL_RE, (match, _q, target) => (isDataUrl(target.trim()) ? match : 'url("data:,")'))
    .replace(/expression\s*\(/gi, "x-blocked(")
    .replace(/behavior\s*:/gi, "x-blocked-a:")
    .replace(/-moz-binding\s*:/gi, "x-blocked-b:")
    .replace(/javascript\s*:/gi, "x-blocked:");
}

// SVG presentation attributes are CSS values too (fill="url(…)", mask,
// clip-path, filter, markers…). Only same-document references (#id — a
// gradient, a clip path) are kept; any other url() becomes "none", so nothing
// can be fetched.
function sanitizeSvgAttr(value) {
  if (!String(value || "").includes("(")) return value;
  return neutraliseUrlStrings(decodeCssIdentEscapes(value)).replace(URL_RE, (match, _q, target) => (/^\s*#[\w-]+\s*$/.test(target) ? match : "none"));
}

/**
 * → sanitized HTML string (full document, `<!DOCTYPE html>` prefixed).
 * Adds `data-page="{n}"` to every pdf2htmlEX page (`div.pf`) and
 * `data-line="p{page}-l{index}"` (1-based) to every text line (`div.t`), in
 * document order (§7.1). Existing data-* attributes are kept.
 */
export function sanitizeTemplateHtml(html) {
  let page = 0;
  let line = 0;

  const transform = (tagName, attribs) => {
    const out = { ...attribs };
    for (const name of Object.keys(out)) {
      if (/^on/i.test(name)) delete out[name];
    }
    if (out.style) out.style = sanitizeCss(out.style);
    if (SVG_TAGS.includes(tagName)) {
      for (const name of Object.keys(out)) if (name !== "style") out[name] = sanitizeSvgAttr(out[name]);
    }
    if (tagName === "img" && !isDataUrl(out.src)) delete out.src;
    if (tagName === "image") {
      for (const k of ["href", "xlink:href"]) if (out[k] && !/^\s*data:image\//i.test(out[k])) delete out[k];
    }
    if (tagName === "meta") {
      delete out["http-equiv"];
      if (!out.name) delete out.content; // content only means something next to a name
    }
    if (tagName === "div") {
      const classes = (out.class || "").split(/\s+/);
      if (classes.includes("pf")) {
        page += 1;
        line = 0;
        out["data-page"] = String(page);
      }
      if (classes.includes("t")) {
        line += 1;
        out["data-line"] = `p${page || 1}-l${line}`;
      }
    }
    return { tagName, attribs: out };
  };

  const cleaned = sanitizeHtml(String(html), {
    allowedTags: ALLOWED_TAGS,
    allowVulnerableTags: true, // <style> is allowed on purpose; its content goes through sanitizeCss below
    allowedAttributes: {
      "*": GLOBAL_ATTRS,
      img: ["src"],
      image: ["href", "xlink:href", "x", "y", "width", "height", "preserveaspectratio"],
      meta: ["charset", "name", "content"],
      style: ["type", "media"],
      html: ["xmlns", "lang", "dir"],
      ...Object.fromEntries(SVG_TAGS.filter((t) => t !== "image").map((t) => [t, SVG_ATTRS])),
    },
    allowedSchemes: ["data"],
    allowedSchemesByTag: {},
    allowedSchemesAppliedToAttributes: ["src", "href", "xlink:href", "cite"],
    allowProtocolRelative: false,
    transformTags: { "*": transform },
    nonTextTags: ["script", "textarea", "option", "noscript", "iframe", "object", "embed", "template", "foreignobject"],
    parser: { lowerCaseTags: true, lowerCaseAttributeNames: true },
  });

  // sanitize-html passes <style> bodies through verbatim (its textFilter is not
  // applied to them), so their CSS is sanitised here, on its normalised output.
  const withCleanCss = cleaned.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open, css, close) => open + sanitizeCss(css) + close);

  return `<!DOCTYPE html>\n${withCleanCss.replace(/^\s*<!doctype[^>]*>\s*/i, "")}`;
}

/** Cheap structural facts used right after sanitizing (no browser needed). */
export function describeSanitized(html) {
  return {
    pages: (html.match(/data-page="/g) || []).length,
    lines: (html.match(/data-line="/g) || []).length,
    isPdf2htmlEX: /class="pf[\s"]/.test(html),
  };
}
