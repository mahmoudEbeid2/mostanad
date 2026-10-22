// Only the cert-renderer service runs Chromium (plan §5.3). Static checks, no
// processes: puppeteer is imported by engine/renderer.js alone; renderer.js
// and renderOps.js are loaded only by the service; Chromium is installed only
// in the cert-renderer image; every compose file wires callers to the service.
import fs from "node:fs";
import path from "node:path";
import { makeAssert } from "./helpers.js";

const { assert, counts } = makeAssert();
const ROOT = path.resolve(import.meta.dirname, "../..");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(m?js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const sources = [...files(path.join(ROOT, "src")), ...files(path.join(ROOT, "scripts"))].map((p) => ({ file: rel(p), text: fs.readFileSync(p, "utf8") }));
const importing = (re) => sources.filter((s) => re.test(s.text)).map((s) => s.file).sort();

// import … from "puppeteer" / "puppeteer-core", import("puppeteer"), require("puppeteer")
const PUPPETEER = /(from\s+|import\s*\(\s*|require\s*\(\s*)["']puppeteer(-core)?["']/;
const RENDERER = /(from\s+|import\s*\(\s*)["'][^"']*(engine\/|\.\/)renderer\.js["']/;
const RENDER_OPS = /(from\s+|import\s*\(\s*)["'][^"']*renderOps\.js["']/;

assert("puppeteer is imported only by engine/renderer.js", JSON.stringify(importing(PUPPETEER)) === JSON.stringify(["src/services/certificates/engine/renderer.js"]), importing(PUPPETEER));
assert(
  "engine/renderer.js is loaded only by the service and renderOps",
  JSON.stringify(importing(RENDERER)) === JSON.stringify(["src/services/certificates/engine/renderOps.js", "src/services/certificates/renderService/server.js"]),
  importing(RENDERER)
);
assert("renderOps.js is loaded only by the service", JSON.stringify(importing(RENDER_OPS)) === JSON.stringify(["src/services/certificates/renderService/server.js"]), importing(RENDER_OPS));
const callers = ["templates/templateService.js", "templates/prepareEngine.js", "templates/fieldService.js", "certificates/editService.js"];
assert("every former renderer caller uses rendererClient", callers.every((c) => /engine\/rendererClient\.js/.test(fs.readFileSync(path.join(ROOT, "src/services/certificates", c), "utf8"))), callers);

const appDocker = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
const rendererDocker = fs.readFileSync(path.join(ROOT, "docker/cert-renderer/Dockerfile"), "utf8");
assert("the API/worker image installs no Chromium", !/^\s*RUN[^\n]*\bchromium\b/im.test(appDocker) && /PUPPETEER_SKIP_DOWNLOAD=true/.test(appDocker), appDocker.split("\n").filter((l) => /chromium|PUPPETEER/i.test(l)));
assert("the cert-renderer image installs Chromium", /\bchromium\b/.test(rendererDocker), null);

for (const f of ["docker-compose.yml", "docker-compose.prod.yml"]) {
  const y = fs.readFileSync(path.join(ROOT, f), "utf8");
  // a service's own lines, comments dropped (the comment above the NEXT service lands in this chunk)
  const block = (name) =>
    (y.split(/\n(?=  [a-z][\w-]*:\s*\n)/).find((b) => b.startsWith(`  ${name}:`) || b.includes(`\n  ${name}:`)) || "")
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
  assert(`${f}: has a cert-renderer service`, /\n  cert-renderer:\s*\n/.test(y), null);
  for (const svc of ["mostanad-app", "certificate-template-worker", "certificate-render-worker"]) {
    assert(`${f}: ${svc} → CERT_RENDERER_URL=http://cert-renderer:5070`, /CERT_RENDERER_URL=http:\/\/cert-renderer:5070/.test(block(svc)), null);
  }
  assert(`${f}: cert-renderer is not routed by Traefik and publishes no port`, !/traefik\./i.test(block("cert-renderer")) && !/\n\s+ports:/.test(block("cert-renderer")), block("cert-renderer"));
}
const prod = fs.readFileSync(path.join(ROOT, "docker-compose.prod.yml"), "utf8");
assert("prod: cert-renderer requires CERT_RENDERER_TOKEN", /CERT_RENDERER_TOKEN=\$\{CERT_RENDERER_TOKEN:\?/.test(prod), null);

console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
process.exit(counts.failed > 0 ? 1 : 0);
