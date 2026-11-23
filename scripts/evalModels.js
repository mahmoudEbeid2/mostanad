import "dotenv/config";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

// Model comparison (2026-11-23): the live AI evals — invoice extraction,
// product matching, gap filling, product inference (tier I + web), and the
// 10-question assistant eval — run once per model, every task on that model
// (AI_MODEL_DEFAULT = AI_MODEL_FALLBACK = it: no fallback, so a failure counts
// against the model that failed). Accuracy comes from each eval's scorecard;
// failures, latency and cost from the AI ledger rows of the run.
// Opt-in and paid: RUN_LIVE_GEMINI=1. Needs Postgres (and the internet for the
// inference eval's web lookups).
//
//   RUN_LIVE_GEMINI=1 node scripts/evalModels.js [--models gemini-2.5-flash,gemini-3.1-flash-lite] [--only invoice,assistant]
//
// Writes golden/ai-eval-models-<date>.json (+ .md) and keeps each eval's own
// scorecard under golden/model-evals/<model>/. Never changes production config.

if (process.env.RUN_LIVE_GEMINI !== "1") {
  console.error("Refusing to run: this calls the paid Gemini API. Set RUN_LIVE_GEMINI=1 to run it.");
  process.exit(2);
}
const arg = (name, dflt) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt);
const MODELS = arg("--models", "gemini-2.5-flash,gemini-3.1-flash-lite").split(",").map((m) => m.trim()).filter(Boolean);
const EVALS = [
  { key: "invoice", label: "Invoice extraction", script: "scripts/evalInvoiceExtract.js", out: "--out", score: (c) => c.totals && { accuracy: c.totals.accuracy, detail: `${c.totals.fieldsRight}/${c.totals.fieldsChecked} fields` } },
  { key: "matching", label: "Product matching", script: "scripts/evalCertMatching.js", produced: /^ai-eval-match-.*\.json$/, score: (c) => c.totals && { accuracy: c.totals.correctRate, detail: `cross-tenant ${c.totals.crossTenant}` } },
  { key: "gaps", label: "Gap filling (invoice text)", script: "scripts/evalCertGaps.js", produced: /^ai-eval-gaps-.*\.json$/, score: (c) => c.totals && { accuracy: c.totals.fillRate ?? c.totals.filledRate ?? null, detail: `unverified ${c.totals.unverified ?? "?"}` } },
  { key: "inference", label: "Product inference (I + web)", script: "scripts/evalCertInference.js", produced: /^ai-eval-inference-.*\.json$/, score: (c) => c.totals && { accuracy: c.totals.fillRate, detail: `false values ${c.totals.falseValues}` } },
  { key: "assistant", label: "Assistant (10 questions, function calling)", script: "scripts/evalAssistant.js", out: "--out", score: (c) => c.totals && { accuracy: c.totals.passed / c.totals.of, detail: `${c.totals.passed}/${c.totals.of} passed` } },
];
const only = arg("--only", null)?.split(",");
const evals = only ? EVALS.filter((e) => only.includes(e.key)) : EVALS;
const GOLDEN = path.join(process.cwd(), "golden");
const date = new Date().toISOString().slice(0, 10);
const { prisma } = await import("../src/lib/prisma.js");

const report = { date: new Date().toISOString(), models: MODELS, rows: [] };
for (const model of MODELS) {
  const dir = path.join(GOLDEN, "model-evals", model);
  fs.mkdirSync(dir, { recursive: true });
  for (const e of evals) {
    const before = new Set(fs.readdirSync(GOLDEN));
    const outFile = path.join(dir, `${e.key}-${date}.json`);
    const started = new Date();
    console.log(`\n▶ ${model} · ${e.label}`);
    const env = { ...process.env, RUN_LIVE_GEMINI: "1", AI_MODEL_DEFAULT: model, AI_MODEL_FALLBACK: model, GEMINI_DISABLED: "false" };
    const res = spawnSync(process.execPath, [e.script, ...(e.out ? [e.out, outFile] : [])], { env, encoding: "utf8", timeout: 30 * 60_000 });
    process.stdout.write((res.stdout || "").split("\n").slice(-25).join("\n"));
    if (res.status && res.stderr) process.stdout.write(`\n  stderr: ${res.stderr.split("\n").slice(-4).join(" | ")}\n`);
    // an existing eval writes its own dated scorecard into golden/: move it next to this model's results
    if (e.produced) {
      for (const f of fs.readdirSync(GOLDEN).filter((f) => e.produced.test(f) && (!before.has(f) || fs.statSync(path.join(GOLDEN, f)).mtime >= started))) fs.renameSync(path.join(GOLDEN, f), outFile);
    }
    const scorecard = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : null;
    const calls = await prisma.aiCall.findMany({ where: { createdAt: { gte: started } }, select: { modelId: true, outcome: true, httpStatus: true, latencyMs: true, costUsd: true } });
    const ok = calls.filter((c) => c.outcome === "ok");
    const byStatus = {};
    for (const c of calls.filter((x) => x.outcome !== "ok")) byStatus[c.httpStatus ?? "timeout/other"] = (byStatus[c.httpStatus ?? "timeout/other"] || 0) + 1;
    const cost = calls.every((c) => c.costUsd !== null) ? calls.reduce((a, c) => a + Number(c.costUsd || 0), 0) : null;
    report.rows.push({
      model,
      eval: e.key,
      label: e.label,
      exit: res.status,
      ...(scorecard ? e.score(scorecard) || {} : { accuracy: null, detail: "no scorecard (the eval failed before scoring)" }),
      attempts: calls.length,
      answered: ok.length,
      failures: byStatus,
      avgLatencyMs: ok.length ? Math.round(ok.reduce((a, c) => a + c.latencyMs, 0) / ok.length) : null,
      costUsd: cost,
      modelsSeen: [...new Set(calls.map((c) => c.modelId))],
    });
  }
}
const pct = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)} %`);
const md = [
  `# Model comparison — ${date}`,
  "",
  "| Task | Model | Accuracy | Detail | Calls (ok/sent) | Failures | Avg latency | Cost |",
  "|---|---|---|---|---|---|---|---|",
  ...report.rows.map((r) => `| ${r.label} | ${r.model} | ${pct(r.accuracy)} | ${r.detail || ""} | ${r.answered}/${r.attempts} | ${Object.entries(r.failures).map(([k, v]) => `${k}×${v}`).join(", ") || "—"} | ${r.avgLatencyMs ?? "—"} ms | ${r.costUsd === null ? "unpriced" : `$${r.costUsd.toFixed(4)}`} |`),
].join("\n");
fs.writeFileSync(path.join(GOLDEN, `ai-eval-models-${date}.json`), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(GOLDEN, `ai-eval-models-${date}.md`), md);
console.log(`\n${md}`);
await prisma.$disconnect();
