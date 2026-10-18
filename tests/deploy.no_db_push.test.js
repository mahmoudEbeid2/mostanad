// No container, script or compose file may ever sync the schema with
// `prisma db push` or `--accept-data-loss`: both drop every table/column the
// running image's schema lacks. A stale app image wiped the dev DB twice that
// way (PROGRESS.md, Certificates V2 Phase 1). Schema changes go through
// additive migrations + `prisma migrate deploy` only. Static check, no server.
import fs from "fs";
import path from "path";

const ROOT = path.resolve(process.cwd());
const FORBIDDEN = [/db\s+push/i, /accept-data-loss/i];

let passed = 0;
let failed = 0;
function assert(label, condition, details = "") {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}${details ? `\n     → ${details}` : ""}`);
    failed++;
  }
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// every file that can start a container or run as a deploy step
const targets = new Set(["scripts/start.sh", "Dockerfile"].filter(exists));
for (const f of fs.readdirSync(ROOT)) {
  if (/^docker-compose.*\.ya?ml$/i.test(f) || /^Dockerfile/i.test(f)) targets.add(f);
}
for (const f of fs.readdirSync(path.join(ROOT, "scripts"))) {
  if (f.endsWith(".sh")) targets.add(`scripts/${f}`);
}
if (exists("docker")) {
  for (const d of fs.readdirSync(path.join(ROOT, "docker"))) {
    const dir = path.join(ROOT, "docker", d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (/^Dockerfile|\.sh$/i.test(f)) targets.add(rel(path.join(dir, f)));
  }
}

console.log("\n🧪 Deploy files never push the schema or accept data loss");
assert("start.sh is checked", targets.has("scripts/start.sh"));
assert("the 3 compose files are checked", ["docker-compose.yml", "docker-compose.dev.yml", "docker-compose.prod.yml"].every((f) => targets.has(f)), [...targets].join(", "));

for (const file of [...targets].sort()) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const hits = text
    .split(/\r?\n/)
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => FORBIDDEN.some((re) => re.test(line)));
  assert(`${file}: no "db push" / "accept-data-loss"`, hits.length === 0, hits.map((h) => `${h.n}: ${h.line.trim()}`).join(" | "));
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const badScripts = Object.entries(pkg.scripts || {}).filter(([, cmd]) => FORBIDDEN.some((re) => re.test(cmd)));
assert('package.json scripts: no "db push" / "accept-data-loss"', badScripts.length === 0, badScripts.map(([k, v]) => `${k}: ${v}`).join(" | "));

const start = fs.readFileSync(path.join(ROOT, "scripts/start.sh"), "utf8");
assert("start.sh applies migrations with `prisma migrate deploy`", /prisma migrate deploy/.test(start));

console.log(`\n📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);
