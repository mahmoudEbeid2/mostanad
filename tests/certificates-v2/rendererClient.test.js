// rendererClient (plan §5.3) against fake renderers: no Chromium, no API, no DB.
// timeouts → RENDERER_UNREACHABLE · 503 → retried, then RENDERER_BUSY ·
// connection refused → RENDERER_UNREACHABLE · 500 → RENDER_FAILED with the
// renderer's message · token header sent · Buffers and PDFs come back intact.
import http from "node:http";
import { makeAssert } from "./helpers.js";

const client = await import("../../src/services/certificates/engine/rendererClient.js");
const { assert, counts } = makeAssert();

// fake renderer: handler(req, body, n) → { status, json?, buf?, headers?, hang? }
async function fake(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      const r = handler(req, seen.length);
      if (r.hang) return; // never answers
      const buf = r.buf || Buffer.from(JSON.stringify(r.json ?? {}));
      res.writeHead(r.status, { "Content-Type": r.buf ? "application/pdf" : "application/json", ...(r.headers || {}) });
      res.end(buf);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.CERT_RENDERER_URL = `http://127.0.0.1:${server.address().port}`;
  return { seen, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

const fails = async (p) => {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
};

process.env.CERT_RENDERER_BACKOFF_MS = "50";
delete process.env.CERT_RENDERER_TOKEN;

let exitCode = 1;
try {
  console.log("\n🧪 Success: shapes kept, Buffers decoded");
  let f = await fake(() => ({ status: 200, json: [{ page: 1, png: { $b64: Buffer.from("PNGDATA").toString("base64") }, width: 10, height: 20 }] }));
  const shots = await client.screenshotPages("<html></html>", { scale: 0.25 });
  assert("screenshotPages → [{ page, png: Buffer, width, height }]", Buffer.isBuffer(shots[0].png) && shots[0].png.toString() === "PNGDATA" && shots[0].width === 10, shots);
  assert("request carries html + options as JSON on /v1/screenshot", f.seen[0].path === "/v1/screenshot" && JSON.parse(f.seen[0].body).scale === 0.25 && JSON.parse(f.seen[0].body).html === "<html></html>", f.seen[0]);
  assert("no token header when CERT_RENDERER_TOKEN is unset", f.seen[0].headers["x-renderer-token"] === undefined, f.seen[0].headers);
  await f.close();

  f = await fake(() => ({ status: 200, buf: Buffer.from("%PDF-1.4 fake"), headers: { "X-Pages": "1", "X-Width-Px": "793.6875", "X-Height-Px": "1122.515625" } }));
  process.env.CERT_RENDERER_TOKEN = "s3cret";
  const pdf = await client.printPdf("<html></html>");
  assert("printPdf → { pdf: Buffer, pages, widthPx, heightPx } from the binary response", Buffer.isBuffer(pdf.pdf) && pdf.pdf.toString().startsWith("%PDF") && pdf.pages === 1 && pdf.widthPx === 793.6875 && pdf.heightPx === 1122.515625, pdf);
  assert("token sent in X-Renderer-Token", f.seen[0].headers["x-renderer-token"] === "s3cret", f.seen[0].headers);
  delete process.env.CERT_RENDERER_TOKEN;
  await f.close();

  console.log("\n🧪 Busy → retry");
  f = await fake((req, n) => (n <= 2 ? { status: 503, json: { code: "RENDERER_BUSY" } } : { status: 200, json: { pages: [], lines: [{ id: "p1-l1" }] } }));
  const t0 = Date.now();
  const ok = await client.analyse("<html></html>");
  assert("two 503s then success → the result, after 3 requests", ok.lines[0].id === "p1-l1" && f.seen.length === 3, { seen: f.seen.length });
  assert("backoff between retries (50 + 100 ms)", Date.now() - t0 >= 140, Date.now() - t0);
  await f.close();

  f = await fake(() => ({ status: 503, json: { code: "RENDERER_BUSY" } }));
  let err = await fails(client.analyse("<html></html>"));
  assert("always 503 → RENDERER_BUSY (503) after 1 + 3 attempts", err?.code === "RENDERER_BUSY" && err.statusCode === 503 && f.seen.length === 4, { code: err?.code, n: f.seen.length });
  await f.close();

  console.log("\n🧪 Failures map to clear codes");
  f = await fake(() => ({ status: 500, json: { code: "RENDER_FAILED", error: "Render timed out after 30000 ms (prepare:clear)" } }));
  err = await fails(client.prepareClear("<html></html>", { inspectDefs: [], clearFields: [] }));
  assert("500 → RENDER_FAILED (502) with the renderer's message, not retried", err?.code === "RENDER_FAILED" && err.statusCode === 502 && /timed out after 30000 ms \(prepare:clear\)/.test(err.message) && f.seen.length === 1, { code: err?.code, msg: err?.message, n: f.seen.length });
  await f.close();

  f = await fake(() => ({ status: 401, json: { code: "UNAUTHORIZED" } }));
  err = await fails(client.fill("<html></html>", { values: {}, defs: [] }));
  assert("401 → RENDERER_UNREACHABLE naming the token", err?.code === "RENDERER_UNREACHABLE" && /CERT_RENDERER_TOKEN/.test(err.message), err?.message);
  await f.close();

  f = await fake(() => ({ hang: true }));
  process.env.CERT_RENDERER_TIMEOUT_MS = "300";
  const t1 = Date.now();
  err = await fails(client.inspect("<html></html>", { fields: [] }));
  assert("no answer → RENDERER_UNREACHABLE 'did not answer within 300 ms' after ~300 ms", err?.code === "RENDERER_UNREACHABLE" && /did not answer within 300 ms/.test(err.message) && Date.now() - t1 < 2000, { msg: err?.message, ms: Date.now() - t1 });
  delete process.env.CERT_RENDERER_TIMEOUT_MS;
  await f.close();

  // a port with nothing listening
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  process.env.CERT_RENDERER_URL = `http://127.0.0.1:${deadPort}`;
  err = await fails(client.markGenericLines("<html></html>"));
  assert("connection refused → RENDERER_UNREACHABLE (503) with the cause", err?.code === "RENDERER_UNREACHABLE" && err.statusCode === 503 && /ECONNREFUSED/.test(err.message), err?.message);
  const h = await client.health();
  assert("health() on a dead renderer → { ok: false, error, url }", h.ok === false && h.error && h.url.endsWith(String(deadPort)), h);

  exitCode = counts.failed > 0 ? 1 : 0;
} finally {
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
  process.exit(exitCode);
}
