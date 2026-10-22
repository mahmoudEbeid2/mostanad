// cert-renderer service (plan §5.3), real Chromium, in this process on a free
// port: auth, refusals, size limit, busy, idle close → relaunch through the
// service, no HTML in logs, and no start in production without a token.
// No API, no database.
process.env.CERT_BROWSER_IDLE_MS = "1500";
process.env.CERT_RENDER_PAGES = "1";
import http from "node:http";
import { spawnSync } from "node:child_process";
const { makeAssert } = await import("./helpers.js");
const { startRenderService } = await import("../../src/services/certificates/renderService/server.js");
const client = await import("../../src/services/certificates/engine/rendererClient.js");

const { assert, counts } = makeAssert();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARKER = "SECRET-VALUE-7f3a";
const doc = `<!DOCTYPE html><html><head><title>t</title></head><body><div data-page="1" style="width:200px;height:100px"><p>${MARKER}</p></div></body></html>`;

const generic = `<!DOCTYPE html><html><head><title>g</title></head><body><p>${MARKER}</p></body></html>`; // not pdf2htmlEX: no data-page yet
const logs = [];
const svc = await startRenderService({ port: 0, host: "127.0.0.1", token: "tok-123", maxBytes: 200_000, maxPending: 1, production: false, log: (l) => logs.push(l) });
const base = `http://127.0.0.1:${svc.port}`;
process.env.CERT_RENDERER_URL = base;
process.env.CERT_RENDERER_TOKEN = "tok-123";
process.env.CERT_RENDERER_BACKOFF_MS = "50";

const raw = (path, body, headers = {}) =>
  fetch(base + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const health = () => fetch(`${base}/health`).then((r) => r.json());

let exitCode = 1;
try {
  console.log("\n🧪 Health and lazy launch");
  let h = await health();
  assert("GET /health → ok, no browser yet, 1 page, idle 1500 ms", h.ok && h.renderer.connected === false && h.renderer.poolSize === 1 && h.renderer.idleMs === 1500, h);

  console.log("\n🧪 Auth and refusals");
  let r = await raw("/v1/analyse", { html: doc });
  assert("no token → 401 UNAUTHORIZED", r.status === 401 && r.body?.code === "UNAUTHORIZED", r);
  r = await raw("/v1/analyse", { html: doc }, { "x-renderer-token": "wrong" });
  assert("wrong token → 401", r.status === 401, r);
  const T = { "x-renderer-token": "tok-123" };
  r = await raw("/v1/nope", { html: doc }, T);
  assert("unknown operation → 404", r.status === 404 && r.body?.code === "NOT_FOUND", r);
  r = await raw("/v1/analyse", "{not json", T);
  assert("body not JSON → 400 BAD_REQUEST", r.status === 400 && r.body?.code === "BAD_REQUEST", r);
  r = await raw("/v1/analyse", { nohtml: 1 }, T);
  assert("no html → 400 BAD_REQUEST", r.status === 400 && r.body?.code === "BAD_REQUEST", r);
  r = await raw("/v1/analyse", { html: "x".repeat(300_000) }, T);
  assert("body over the limit → 413 TOO_LARGE", r.status === 413 && r.body?.code === "TOO_LARGE", r);
  h = await health();
  assert("refusals launched no browser", h.renderer.connected === false, h);

  console.log("\n🧪 Renders through the client");
  const marked = await client.markGenericLines(generic);
  assert("markGenericLines → { marked, html } with the text marked as lines", marked.marked === true && marked.lines === 1 && marked.html.includes(MARKER), { marked: marked.marked });
  const a = await client.analyse(marked.html);
  assert("analyse → { pages, lines } with the document's text", a.pages.length === 1 && a.lines.some((l) => l.text.includes(MARKER)), a);
  const p = await client.printPdf(doc);
  assert("printPdf → a 1-page PDF streamed as binary", p.pdf.subarray(0, 5).toString() === "%PDF-" && p.pages === 1 && p.widthPx === 200, { pages: p.pages, w: p.widthPx, bytes: p.pdf.length });
  const shots = await client.screenshotPages(doc, { scale: 0.5 });
  assert("screenshotPages → PNG Buffers at the requested scale", shots.length === 1 && shots[0].png.subarray(1, 4).toString() === "PNG" && shots[0].width === 100, { n: shots.length, w: shots[0]?.width });
  const bad = await client.prepareClear(doc, { inspectDefs: [], clearFields: null }).then(() => null, (e) => e);
  assert("an engine error → RENDER_FAILED with a message that does not contain the document", bad?.code === "RENDER_FAILED" && !bad.message.includes(MARKER), bad?.message);

  console.log("\n🧪 Busy: requests waiting beyond the limit are refused, not queued forever");
  // hold one request open mid-body so it counts as pending
  const held = http.request(`${base}/v1/analyse`, { method: "POST", headers: { "Content-Type": "application/json", "x-renderer-token": "tok-123", "Content-Length": 1000 } });
  held.on("error", () => {});
  held.write("{");
  await sleep(150);
  r = await raw("/v1/analyse", { html: doc }, T);
  assert("second request while one is pending (max 1) → 503 RENDERER_BUSY", r.status === 503 && r.body?.code === "RENDERER_BUSY", r);
  held.destroy();
  await sleep(150);
  h = await health();
  assert("pending back to 0 after the held request is dropped", h.pending === 0, h);

  console.log("\n🧪 Idle close and relaunch through the service");
  h = await health();
  const first = h.renderer;
  assert("browser running after the renders, idle close armed", first.connected && first.idleCloseArmed, first);
  await sleep(2300);
  h = await health();
  assert("closed after 1.5 s idle", h.renderer.connected === false && h.renderer.idleCloses === 1, h.renderer);
  const again = await client.analyse(marked.html);
  h = await health();
  assert("next render relaunches the browser and works", again.lines.length > 0 && h.renderer.connected && h.renderer.idleCloses === 1, h.renderer);

  console.log("\n🧪 Logs");
  assert("one log line per request, none contains the document or a value", logs.length >= 10 && logs.every((l) => !l.includes(MARKER) && !l.includes("<html")), logs.slice(-3));

  console.log("\n🧪 Production needs a token");
  const e = await startRenderService({ port: 0, token: "", production: true, log: () => {} }).then(() => null, (x) => x);
  assert("startRenderService in production without a token throws", /CERT_RENDERER_TOKEN is required/.test(e?.message || ""), e?.message);
  const child = spawnSync(process.execPath, ["src/services/certificates/renderService/server.js"], { env: { ...process.env, NODE_ENV: "production", CERT_RENDERER_TOKEN: "", CERT_RENDERER_PORT: "0" }, encoding: "utf8", timeout: 20_000 });
  assert("the process exits 1 with the reason", child.status === 1 && /CERT_RENDERER_TOKEN is required/.test(child.stderr), { status: child.status, stderr: child.stderr });

  exitCode = counts.failed > 0 ? 1 : 0;
} finally {
  await svc.close();
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
  process.exit(exitCode);
}
