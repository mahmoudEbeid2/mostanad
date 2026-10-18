import { CertError } from "../errors.js";

// Client for the self-hosted pdf2htmlex service (docker/pdf2htmlex, plan D2).
// Always converts at zoom 4/3 so that 1 CSS px = 1/96 in = true physical size
// (plan §3.3 P8) — the PDF export depends on it.
export const CONVERT_ZOOM = "1.3333333333";

const baseUrl = () => (process.env.PDF2HTMLEX_URL || "http://127.0.0.1:5050").replace(/\/$/, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(buffer, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl()}/convert?zoom=${CONVERT_ZOOM}`, {
      method: "POST",
      body: buffer,
      headers: { "Content-Type": "application/pdf" },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Converts PDF bytes (an Illustrator .ai with PDF content is a PDF) to HTML.
 * → { html, ms, toolVersion, textLines, warnings[] }
 * Errors: 422 NO_PDF_CONTENT · 503 CONVERTER_BUSY (after retries) ·
 * 503 CONVERTER_UNREACHABLE · 502 CONVERSION_FAILED.
 */
export async function convert(buffer, { retries = 3, timeoutMs = 120_000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await post(buffer, timeoutMs);
    } catch (err) {
      throw new CertError(
        "CONVERTER_UNREACHABLE",
        `The pdf2htmlex converter is not reachable at ${baseUrl()}: ${err.name === "AbortError" ? "timed out" : err.message}`,
        503
      );
    }
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    if (res.ok && body?.html) return body;
    if (res.status === 422) {
      throw new CertError("NO_PDF_CONTENT", body?.error || "The file has no PDF content.", 422);
    }
    if (res.status === 503 && attempt <= retries) {
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.status === 503) throw new CertError("CONVERTER_BUSY", "The converter is busy; try again shortly.", 503);
    throw new CertError("CONVERSION_FAILED", body?.error || `Conversion failed (HTTP ${res.status})`, 502, {
      details: body?.details ? String(body.details).slice(-500) : undefined,
    });
  }
}

/** → { ok, toolVersion } or { ok: false, error } — used by health reporting. */
export async function health() {
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    return { ok: res.ok && !!body.ok, toolVersion: body.toolVersion, url: baseUrl() };
  } catch (err) {
    return { ok: false, error: err.message, url: baseUrl() };
  }
}
