// cert-renderer — the ONE process that runs Chromium (CERTIFICATES_V2_PLAN.md
// §5.3). The API and the certificate workers call it over HTTP through
// engine/rendererClient.js; nothing else imports puppeteer.
//
//   GET  /health                  → { ok, renderer: rendererStats(), pending }
//   POST /v1/analyse              { html }                         → { pages, lines }
//   POST /v1/screenshot           { html, scale? }                 → [{ page, png, width, height }]
//   POST /v1/normalize-background { html, opts? }                  → { stats, html }
//   POST /v1/mark-generic-lines   { html }                         → { marked, …, html }
//   POST /v1/prepare-clear        { html, inspectDefs, clearFields } → { results, detected, html }
//   POST /v1/prepare-roundtrip    { html, samples, defs, … }       → { fill, rects, shots }
//   POST /v1/fill                 { html, values, defs, … }        → { html, flags, geometry, thumbnail }
//   POST /v1/inspect              { html, fields, inspectDefs }    → { fields, groups }
//   POST /v1/pdf                  { html }                         → application/pdf (X-Pages, X-Width-Px, X-Height-Px)
// JSON results carry Buffers as { $b64 } (renderWire.js).
//
// Errors: 401 UNAUTHORIZED · 400 BAD_REQUEST · 404 NOT_FOUND · 413 TOO_LARGE ·
// 503 RENDERER_BUSY (too many requests waiting) · 500 RENDER_FAILED (message only).
// Auth: X-Renderer-Token = CERT_RENDERER_TOKEN, mandatory in production (the
// service refuses to start without it). Logs never contain HTML or values:
// one line per request with the operation, status, sizes and time.

import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import * as renderer from "../engine/renderer.js";
import * as ops from "../engine/renderOps.js";
import { decodeBuffers, encodeBuffers, TOKEN_HEADER } from "../engine/renderWire.js";

const OPS = {
  "/v1/analyse": ({ html }) => renderer.analyse(html),
  "/v1/screenshot": ({ html, ...opts }) => renderer.screenshotPages(html, opts),
  "/v1/normalize-background": ({ html, opts }) => renderer.normalizeBackground(html, opts),
  "/v1/mark-generic-lines": ({ html }) => renderer.markGenericLines(html),
  "/v1/prepare-clear": ({ html, ...opts }) => ops.prepareClear(html, opts),
  "/v1/prepare-roundtrip": ({ html, ...opts }) => ops.prepareRoundTrip(html, opts),
  "/v1/fill": ({ html, ...opts }) => ops.fill(html, opts),
  "/v1/inspect": ({ html, ...opts }) => ops.inspect(html, opts),
  "/v1/pdf": ({ html }) => renderer.printPdf(html),
};

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();

/**
 * Starts the service → { server, port, close() }.
 * Options default to env: CERT_RENDERER_PORT (5070), CERT_RENDERER_TOKEN,
 * CERT_RENDERER_MAX_BYTES (50 MB), CERT_RENDERER_MAX_PENDING (16).
 */
export async function startRenderService({
  port = Number(process.env.CERT_RENDERER_PORT) || 5070,
  host = process.env.CERT_RENDERER_HOST || "0.0.0.0",
  token = process.env.CERT_RENDERER_TOKEN || "",
  maxBytes = Number(process.env.CERT_RENDERER_MAX_BYTES) || 50 * 1024 * 1024,
  maxPending = Number(process.env.CERT_RENDERER_MAX_PENDING) || 16,
  production = process.env.NODE_ENV === "production",
  log = (line) => console.log(`[cert-renderer] ${line}`),
} = {}) {
  if (production && !token) throw new Error("CERT_RENDERER_TOKEN is required in production — refusing to start without it");
  const want = token ? digest(token) : null;
  let pending = 0;

  const send = (res, status, body, headers = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "Content-Type": Buffer.isBuffer(body) ? "application/pdf" : "application/json; charset=utf-8", "Content-Length": buf.length, ...headers });
    res.end(buf);
    return buf.length;
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const declared = Number(req.headers["content-length"]);
      if (declared > maxBytes) return reject(Object.assign(new Error(`Request larger than ${maxBytes} bytes`), { status: 413, code: "TOO_LARGE" }));
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) {
          reject(Object.assign(new Error(`Request larger than ${maxBytes} bytes`), { status: 413, code: "TOO_LARGE" }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const path = (req.url || "").split("?")[0];
    let status = 500;
    let inBytes = 0;
    let outBytes = 0;
    let counted = false;
    try {
      if (req.method === "GET" && path === "/health") {
        status = 200;
        outBytes = send(res, 200, { ok: true, renderer: renderer.rendererStats(), pending });
        return;
      }
      if (want) {
        const got = req.headers[TOKEN_HEADER];
        if (!got || !crypto.timingSafeEqual(digest(got), want)) {
          req.resume();
          status = 401;
          outBytes = send(res, 401, { code: "UNAUTHORIZED", error: "Missing or wrong renderer token" });
          return;
        }
      }
      const op = req.method === "POST" ? OPS[path] : null;
      if (!op) {
        req.resume();
        status = 404;
        outBytes = send(res, 404, { code: "NOT_FOUND", error: `No operation ${req.method} ${path}` });
        return;
      }
      if (pending >= maxPending) {
        req.resume();
        status = 503;
        outBytes = send(res, 503, { code: "RENDERER_BUSY", error: `${pending} renders already waiting` });
        return;
      }
      pending++;
      counted = true;
      const raw = await readBody(req);
      inBytes = raw.length;
      let body;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        throw Object.assign(new Error("Body is not JSON"), { status: 400, code: "BAD_REQUEST" });
      }
      if (!body || typeof body.html !== "string") throw Object.assign(new Error("`html` (string) is required"), { status: 400, code: "BAD_REQUEST" });
      const result = await op(decodeBuffers(body));
      status = 200;
      if (path === "/v1/pdf") {
        outBytes = send(res, 200, result.pdf, { "X-Pages": String(result.pages), "X-Width-Px": String(result.widthPx), "X-Height-Px": String(result.heightPx) });
      } else {
        outBytes = send(res, 200, encodeBuffers(result));
      }
    } catch (err) {
      status = err.status || 500;
      const code = err.code && err.status ? err.code : "RENDER_FAILED";
      // the message only — never the document (engine/puppeteer messages carry no HTML)
      if (!res.headersSent) outBytes = send(res, status, { code, error: String(err.message || err).slice(0, 500) });
      else res.destroy();
    } finally {
      if (counted) pending--;
      if (path !== "/health") log(`${req.method} ${path} ${status} in=${inBytes}B out=${outBytes}B ${Date.now() - t0}ms pending=${pending}`);
    }
  });
  server.requestTimeout = 0; // a render may wait in the page pool longer than Node's default 300 s on a busy box
  server.headersTimeout = 60_000;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  log(`listening on ${host}:${actualPort} (auth ${want ? "on" : "OFF — dev only"}, max ${maxBytes} B, max pending ${maxPending}, pages ${renderer.rendererStats().poolSize}, idle close ${renderer.rendererStats().idleMs} ms)`);

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await renderer.shutdown();
  };
  return { server, port: actualPort, close };
}

// Run as a process: node src/services/certificates/renderService/server.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // dev (npm run dev:all) reads .env like every other process; the image has no
  // dotenv and gets its env from compose
  if (process.env.NODE_ENV !== "production") {
    await import("dotenv/config").catch((err) => console.warn(`[cert-renderer] .env not loaded: ${err.message}`));
  }
  try {
    const svc = await startRenderService();
    const stop = async (sig) => {
      console.log(`[cert-renderer] ${sig}: closing`);
      await Promise.race([svc.close(), new Promise((r) => setTimeout(r, 8000))]);
      process.exit(0);
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
  } catch (err) {
    console.error(`[cert-renderer] ${err.message}`);
    process.exit(1);
  }
}
