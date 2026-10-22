import { CertError } from "../errors.js";
import { decodeBuffers, TOKEN_HEADER } from "./renderWire.js";

// Client for the cert-renderer service (renderService/server.js, plan §5.3).
// Same function names and result shapes as the in-process renderer had, so the
// callers (templateService, prepareEngine, fieldService, editService) only
// changed their import. Every render goes through here; this process never
// starts a browser.
//
// Errors (CertError, surfaced to the task / response like any other):
//   RENDERER_UNREACHABLE 503 — connection failed, no answer within the
//                              timeout, or the token was refused
//   RENDERER_BUSY        503 — still busy after the retries
//   RENDER_FAILED        502 — the render itself failed (message from the renderer)

const baseUrl = () => (process.env.CERT_RENDERER_URL || "http://127.0.0.1:5070").replace(/\/$/, "");
const timeoutMs = () => Number(process.env.CERT_RENDERER_TIMEOUT_MS) || 120_000;
const busyRetries = () => (process.env.CERT_RENDERER_BUSY_RETRIES === undefined ? 3 : Number(process.env.CERT_RENDERER_BUSY_RETRIES));
const backoffMs = () => Number(process.env.CERT_RENDERER_BACKOFF_MS) || 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One exchange; the timeout covers headers AND body (same rule as pdf2htmlexClient).
async function exchange(path, payload, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.CERT_RENDERER_TOKEN) headers[TOKEN_HEADER] = process.env.CERT_RENDERER_TOKEN;
    const res = await fetch(`${baseUrl()}${path}`, { method: "POST", body: JSON.stringify(payload), headers, signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf };
  } finally {
    clearTimeout(timer);
  }
}

async function call(path, payload, { binary = false } = {}) {
  const ms = timeoutMs();
  for (let attempt = 1; ; attempt++) {
    let res;
    let buf;
    try {
      ({ res, buf } = await exchange(path, payload, ms));
    } catch (err) {
      throw new CertError(
        "RENDERER_UNREACHABLE",
        err.name === "AbortError" ? `The renderer at ${baseUrl()} did not answer within ${ms} ms` : `The renderer is not reachable at ${baseUrl()}: ${err.cause?.code || err.cause?.message || err.message}`,
        503
      );
    }
    if (res.ok) {
      if (binary) return { buf, headers: res.headers };
      return decodeBuffers(JSON.parse(buf.toString("utf8")));
    }
    let body = null;
    try {
      body = JSON.parse(buf.toString("utf8"));
    } catch {
      body = null; // not JSON (a proxy error page…): handled by status below
    }
    if (res.status === 503 && attempt <= busyRetries()) {
      await sleep(backoffMs() * 2 ** (attempt - 1));
      continue;
    }
    if (res.status === 503) throw new CertError("RENDERER_BUSY", "The renderer is busy; try again shortly.", 503);
    if (res.status === 401) throw new CertError("RENDERER_UNREACHABLE", "The renderer refused our token — CERT_RENDERER_TOKEN must be the same on the renderer and its callers", 503);
    throw new CertError("RENDER_FAILED", body?.error || `Render failed (HTTP ${res.status})`, 502);
  }
}

export const analyse = (html) => call("/v1/analyse", { html });

export const screenshotPages = (html, opts = {}) => call("/v1/screenshot", { html, ...opts });

/** SVG-background conversion (§7.8, plan §20 I26) → { html, stats } */
export const normalizeBackground = (html, opts) => call("/v1/normalize-background", { html, opts });

export const markGenericLines = (html) => call("/v1/mark-generic-lines", { html });

/** → { pdf: Buffer, pages, widthPx, heightPx } */
export async function printPdf(html) {
  const { buf, headers } = await call("/v1/pdf", { html }, { binary: true });
  return { pdf: buf, pages: Number(headers.get("x-pages")), widthPx: Number(headers.get("x-width-px")), heightPx: Number(headers.get("x-height-px")) };
}

// The former withDocument() closures (engine/renderOps.js), one call each
export const prepareClear = (html, opts) => call("/v1/prepare-clear", { html, ...opts });
export const prepareRoundTrip = (html, opts) => call("/v1/prepare-roundtrip", { html, ...opts });
export const fill = (html, opts) => call("/v1/fill", { html, ...opts });
export const inspect = (html, opts) => call("/v1/inspect", { html, ...opts });

/** → { ok, renderer, pending, url } or { ok: false, error, url } */
export async function health() {
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    return { ...body, ok: res.ok && !!body.ok, url: baseUrl() };
  } catch (err) {
    return { ok: false, error: err.message, url: baseUrl() };
  }
}
