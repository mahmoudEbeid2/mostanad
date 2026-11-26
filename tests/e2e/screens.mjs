// Phase 7 screenshots of each step (after screens.setup.mjs): a headless browser logged in as the local
// screenshot user, on the frontend dev server (FRONT_URL, default http://localhost:5173).
//   node tests/e2e/screens.mjs   → reports/addvet-e2e/screens/NN-name.png
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const OUT = path.join(process.cwd(), "reports", "addvet-e2e", "screens");
const FRONT = process.env.FRONT_URL || "http://localhost:5173";
const API = process.env.API_URL || "http://localhost:3000/api/v1";
const login = JSON.parse(fs.readFileSync(path.join(OUT, ".login.json"), "utf8"));
const ids = JSON.parse(fs.readFileSync(path.join(OUT, "ids.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(login) });
const body = await res.json();
const token = body.token || body.data?.token;
const user = body.data?.user || body.user;
if (!token) throw new Error(`login failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--lang=ar"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
await page.goto(`${FRONT}/login`, { waitUntil: "domcontentloaded" });
await page.evaluate((t, u) => {
  localStorage.setItem("token", t);
  localStorage.setItem("user", JSON.stringify(u));
  localStorage.setItem("lang", "ar");
}, token, user);

const shots = [];
async function shot(name, url, { wait = 2500, before = null, full = true } = {}) {
  if (url) await page.goto(`${FRONT}${url}`, { waitUntil: "networkidle2", timeout: 60_000 }).catch(() => {});
  await sleep(wait);
  if (before) await before().catch((e) => console.log(`  (${name}: ${e.message})`));
  await sleep(800);
  const file = path.join(OUT, `${String(shots.length + 1).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  shots.push(file);
  console.log("saved", path.basename(file));
}
const q = `?companyId=${ids.companyId}`;

// 1 · the chat: the drop's card, the one click, the Express steps and drafts
await shot("chat-addvet-drop", "/assistant", {
  wait: 3000,
  before: async () => {
    await page.click('[data-testid="assistant-history"] button');
    await page.waitForSelector('[data-testid="intake-review"]', { timeout: 20_000 });
    await sleep(4000);
  },
});
// 2 · the urgent orders to review
await shot("urgent-orders", "/express");
// 3 · a draft: what blocks approval named, outlined on the certificate; the review steps
await shot("certificate-draft-blanks", `/certificates/${ids.certificateId}${q}`, { wait: 5000 });
// 4 · the HC template the run couldn't prepare: why, on its screen
if (ids.hcTemplate?.versionId) await shot("hc-template", `/certificates/templates/${ids.hcTemplate.id}/versions/${ids.hcTemplate.versionId}${q}`, { wait: 5000 });
// 5 · a request from pasted names: the matrix of status cells
await shot("request-matrix", `/certificates/requests/${ids.requestId}${q}`, { wait: 4000 });
// 6 · the designer's panel of a product of the request
await shot("designer-panel", null, {
  wait: 500,
  before: async () => {
    await page.click('[data-testid="open-designer"]');
    await page.waitForSelector('[data-testid="designer-panel"]', { timeout: 15_000 });
  },
  full: false,
});
// 7 · the generated certificates list (Arabic)
await shot("certificates-list", `/certificates${q}`);
// 8 · the same certificate screen with the English switch
await page.evaluate(() => localStorage.setItem("lang", "en"));
await shot("certificate-draft-english", `/certificates/${ids.certificateId}${q}`, { wait: 5000 });
await page.evaluate(() => localStorage.setItem("lang", "ar"));

await browser.close();
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(shots.map((s) => path.basename(s)), null, 1));
console.log(`${shots.length} screenshots → ${OUT}`);
