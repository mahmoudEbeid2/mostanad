import dns from "dns/promises";
import net from "net";
import { createRequire } from "module";

// Server-side fetch of a page an AI cited (plan.md §14.3 step 3) — the only
// outbound HTTP the certificate pipeline makes to arbitrary hosts, so it is
// fenced: http(s) only, no credentials in the URL, ports 80/443, every hop's
// address checked (no loopback / private / link-local / CGNAT / multicast —
// a cited URL must never reach the server's own network), redirects followed
// by hand (≤ 5, each re-checked), a timeout, a size cap, and text/html or PDF only.
// → { ok: true, url, finalUrl, host, contentType, text } | { ok: false, reason }

const require = createRequire(import.meta.url);
const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;
const HTML = /^(text\/html|application\/xhtml\+xml)\b/i;
const PDF = /^application\/pdf\b/i;

function privateV4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
/** True for any address a cited page must not live at. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return privateV4(ip);
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateV4(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

async function checkUrl(raw, { allowPrivate }) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { reason: "not a URL" };
  }
  if (!["http:", "https:"].includes(u.protocol)) return { reason: `${u.protocol} URLs are not fetched` };
  if (u.username || u.password) return { reason: "URLs with credentials are not fetched" };
  if (u.port && !["80", "443"].includes(u.port) && !allowPrivate) return { reason: `port ${u.port} is not fetched` };
  if (!allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    let addrs;
    try {
      addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    } catch (err) {
      return { reason: `the host does not resolve (${err.code || err.message})` };
    }
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return { reason: "the host resolves to a private or local address" };
  }
  return { url: u };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", deg: "°", micro: "µ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
/** HTML → visible text (scripts, styles and tags removed, entities decoded, blocks on their own lines). */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/td|\/th)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .trim();
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error(`the page is larger than ${MAX_BYTES / 1024 / 1024} MB`), { capped: true });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** opts.allowPrivate is for tests only (a local test server). */
export async function safeFetch(rawUrl, { allowPrivate = false, timeoutMs = TIMEOUT_MS } = {}) {
  let current = rawUrl;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const c = await checkUrl(current, { allowPrivate });
      if (c.reason) return { ok: false, reason: c.reason };
      const res = await fetch(c.url, { redirect: "manual", signal, headers: { "user-agent": "Mozilla/5.0 (compatible; MostanadCertificateCheck/1.0)", accept: "text/html,application/xhtml+xml,application/pdf;q=0.9" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = new URL(res.headers.get("location"), c.url).toString();
        continue;
      }
      if (!res.ok) return { ok: false, reason: `the page answered HTTP ${res.status}` };
      const type = res.headers.get("content-type") || "";
      if (!HTML.test(type) && !PDF.test(type)) return { ok: false, reason: `not a web page or PDF (${type.split(";")[0] || "no content type"})` };
      const body = await readCapped(res);
      let text;
      if (PDF.test(type)) {
        const pdfParse = require("pdf-parse/lib/pdf-parse.js"); // the lib entry: the package index runs a debug self-test
        text = (await pdfParse(body)).text || "";
      } else text = htmlToText(body.toString("utf8"));
      return { ok: true, url: rawUrl, finalUrl: c.url.toString(), host: c.url.hostname.toLowerCase(), contentType: type.split(";")[0], text };
    }
    return { ok: false, reason: "too many redirects" };
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return { ok: false, reason: "the page did not answer in time" };
    return { ok: false, reason: err.capped ? err.message : `the page could not be fetched (${err.cause?.code || err.message})` };
  }
}
