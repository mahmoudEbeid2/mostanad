import { spawn } from "child_process";

// Single-command local dev: the API process only imports/runs
// referenceLabelWorker.js and productAiWorker.js in-process (see app.js) — the
// other 8 workers are separate processes in docker-compose.yml's `command:`
// entries and never start on their own. This mirrors that exact list so
// `npm run dev:all` matches what actually runs in production, one process per
// line here just like one container per service there.
const targets = [
  { name: "api", script: "src/server.js" },
  { name: "catalog-worker", script: "src/workers/catalogWorker.js" },
  { name: "label-worker", script: "src/workers/labelWorker.js" },
  { name: "certificate-worker", script: "src/workers/certificateWorker.js" },
  { name: "eda-worker", script: "src/workers/edaRequirementWorker.js" },
  { name: "reference-label-worker", script: "src/workers/referenceLabelWorker.js" },
  { name: "ai-template-worker", script: "src/workers/aiTemplateWorker.js" },
  { name: "email-worker", script: "src/workers/emailWorker.js" },
  { name: "label-generator-worker", script: "src/workers/labelGeneratorWorker.js" },
  // Certificates V2 (CERTIFICATES_V2_PLAN.md §5.2)
  { name: "cert-template-worker", script: "src/workers/certificateTemplateWorker.js" },
  { name: "invoice-worker", script: "src/workers/invoiceWorker.js" },
  { name: "cert-render-worker", script: "src/workers/certificateRenderWorker.js" },
];

// Tried Node's built-in --watch here first (no new dependency, matches
// `npm run dev`'s auto-restart). Verified live it doesn't scope to each
// script's module graph on this machine — all 9 processes restarted in
// lockstep, repeatedly, correlated with unrelated filesystem activity
// anywhere under the project root (e.g. test runs writing to
// uploads/temp_jobs/, or a doc edit), not just changes to files they
// actually import. That produced real ECONNREFUSED test failures (the API
// bounced mid-suite). Plain `node`, no watch: restart `npm run dev:all`
// yourself after editing worker code.
// `--no-gemini` (npm run dev:test): every child gets GEMINI_DISABLED=true, so
// no process can reach the Gemini API. `npm test` refuses to run unless every
// queue consumer was started this way (tests/runAll.js preflight).
if (process.argv.includes("--no-gemini")) process.env.GEMINI_DISABLED = "true";

const COLORS = ["\x1b[36m", "\x1b[35m", "\x1b[33m", "\x1b[32m", "\x1b[34m", "\x1b[91m", "\x1b[92m", "\x1b[93m", "\x1b[94m"];
const RESET = "\x1b[0m";

function prefixStream(stream, label, color) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (line.trim()) console.log(`${color}[${label}]${RESET} ${line}`);
    }
  });
}

const children = targets.map(({ name, script }, i) => {
  const color = COLORS[i % COLORS.length];
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  prefixStream(child.stdout, name, color);
  prefixStream(child.stderr, name, color);
  child.on("exit", (code, signal) => {
    console.log(`${color}[${name}]${RESET} exited (code=${code} signal=${signal || ""})`);
  });
  return child;
});

console.log(`Started ${children.length} processes: ${targets.map((t) => t.name).join(", ")}`);
console.log(`Gemini: ${process.env.GEMINI_DISABLED === "true" ? "DISABLED (GEMINI_DISABLED=true)" : "enabled"}`);
console.log("Postgres + Redis are NOT started by this script — bring them up first. Press Ctrl+C to stop all.\n");

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nStopping all processes...");
  for (const child of children) child.kill();
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
