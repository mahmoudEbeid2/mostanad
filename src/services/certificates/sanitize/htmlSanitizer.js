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
const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gis;

export function sanitizeCss(css) {
  if (!css) return css;
  return String(css)
    .replace(/</g, "\\3c ")
    .replace(/@import[^;]*;?/gi, "")
    .replace(URL_RE, (match, _q, target) => (/^data:/i.test(target.trim()) ? match : 'url("data:,")'))
    .replace(/expression\s*\(/gi, "x-blocked(")
    .replace(/behavior\s*:/gi, "x-blocked-a:")
    .replace(/-moz-binding\s*:/gi, "x-blocked-b:")
    .replace(/javascript\s*:/gi, "x-blocked:");
}

const isDataUrl = (v) => /^\s*data:/i.test(v || "");

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
