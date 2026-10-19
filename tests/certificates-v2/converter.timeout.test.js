// Review #17 — the converter timeout covers reading the response body, not only
// waiting for headers. A local server sends 200 + headers, then stalls the body.
// No API, no database.
import http from "http";
import { makeAssert } from "./helpers.js";
import { convert } from "../../src/services/certificates/conversion/pdf2htmlexClient.js";

const { assert, counts } = makeAssert();
const sockets = new Set();
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"html":"<p>'); // …and never finishes
  });
});
server.on("connection", (s) => {
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.PDF2HTMLEX_URL = `http://127.0.0.1:${server.address().port}`;

let exitCode = 1;
try {
  console.log("\n🧪 Headers sent, body stalls");
  const t0 = Date.now();
  const out = await convert(Buffer.from("%PDF-1.4"), { retries: 0, timeoutMs: 800 }).then(
    (x) => ({ ok: x }),
    (e) => ({ err: e })
  );
  const ms = Date.now() - t0;
  assert("rejected with 503 CONVERTER_UNREACHABLE (timed out), not hung", out.err?.code === "CONVERTER_UNREACHABLE" && out.err.statusCode === 503 && /did not answer within 800 ms/.test(out.err.message), out.err?.message || out.ok);
  assert("…within the timeout (+ slack), not after the body would have arrived", ms < 3000, ms);
  exitCode = counts.failed > 0 ? 1 : 0;
} finally {
  for (const s of sockets) s.destroy();
  server.close();
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
  process.exit(exitCode);
}
