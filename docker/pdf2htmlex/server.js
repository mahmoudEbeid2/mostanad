// pdf2htmlex-service — internal conversion service for Mostanad (Certificates V2).
// POST /convert   body: raw PDF bytes (an Illustrator .ai saved with PDF content is a PDF)
//                 query: ?zoom=1 (0.5..4)
//                 → 200 { html, ms, toolVersion, textLines, warnings[] }
// GET  /health    → 200 { ok: true, toolVersion }
//
// Zero dependencies. pdf2htmlEX runs through execFile with an args array (no shell).
// Not exposed publicly: reachable only on the compose network (and localhost:5050 in dev).

import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT) || 5000;
const BIN = process.env.PDF2HTMLEX_BIN || "pdf2htmlEX";
const MAX_BYTES = Number(process.env.MAX_BYTES) || 60 * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 120_000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 2;

let active = 0;
let toolVersion = "unknown";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.details = `${stderr || ""}${stdout || ""}`.slice(-2000);
        return reject(err);
      }
      resolve(`${stdout || ""}${stderr || ""}`);
    });
  });
}

run(BIN, ["--version"])
  .then((out) => { toolVersion = (out.match(/version\s+([\w.\-]+)/i) || [])[1] || out.split("\n")[0]; })
  .catch((e) => console.error(`[pdf2htmlex] cannot run ${BIN}:`, e.message));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error(`File larger than ${MAX_BYTES} bytes`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function convert(req, res, url) {
  if (active >= MAX_CONCURRENT) return json(res, 503, { error: "Converter busy, retry shortly" });

  const buf = await readBody(req);
  if (!buf.length) return json(res, 400, { error: "Empty body" });
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return json(res, 422, {
      code: "NO_PDF_CONTENT",
      error: "File has no PDF content. Re-save the .ai in Illustrator with 'Create PDF Compatible File' checked.",
    });
  }

  const zoom = Math.min(Math.max(Number(url.searchParams.get("zoom")) || 1, 0.5), 4);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p2h-"));
  const input = path.join(dir, "input.pdf");
  fs.writeFileSync(input, buf);

  active++;
  const started = Date.now();
  try {
    await run(BIN, [
      "--zoom", String(zoom),
      "--process-outline", "0",
      "--embed-css", "1",
      "--embed-font", "1",
      "--embed-image", "1",
      "--embed-javascript", "0",
      "--dest-dir", dir,
      input,
      "output.html",
    ]);
    const outFile = path.join(dir, "output.html");
    if (!fs.existsSync(outFile)) throw new Error("pdf2htmlEX produced no output");
    const html = fs.readFileSync(outFile, "utf8");

    const textLines = (html.match(/<div class="t[ "]/g) || []).length;
    const warnings = [];
    if (textLines === 0) warnings.push("NO_TEXT: text was converted to outlines (or the file has no live text).");
    if (/saved without PDF Content/i.test(html)) {
      return json(res, 422, {
        code: "NO_PDF_CONTENT",
        error: "Illustrator placeholder page detected. Re-save with 'Create PDF Compatible File' checked.",
      });
    }

    json(res, 200, { html, ms: Date.now() - started, toolVersion, textLines, warnings });
  } catch (err) {
    console.error("[pdf2htmlex] conversion failed:", err.message, err.details || "");
    json(res, 500, { error: `Conversion failed: ${err.message}`, details: err.details });
  } finally {
    active--;
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, toolVersion });
    if (req.method === "POST" && url.pathname === "/convert") return await convert(req, res, url);
    json(res, 404, { error: "Not found" });
  } catch (err) {
    json(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`[pdf2htmlex] listening on :${PORT} using ${BIN}`));
