// Certificates V2 §14 / §16.1 — the sanitizer neutralises the malicious corpus,
// and a sanitized document can execute nothing and reach no network even when
// loaded in a real browser. Also: line/page ids and CSS sanitising.
// No API server needed (renderer runs in-process).
import { fixture, makeAssert, finish } from "./helpers.js";
import { sanitizeTemplateHtml, sanitizeCss } from "../../src/services/certificates/sanitize/htmlSanitizer.js";
import * as renderer from "../../src/services/certificates/engine/renderer.js";
import puppeteer from "puppeteer";

const { assert, counts } = makeAssert();

console.log("\n🧪 Sanitizer — malicious corpus (static)");
const raw = fixture("malicious.html").toString("utf8");
const out = sanitizeTemplateHtml(raw);
// CSS bodies are checked separately (they are inert text with "<" escaped)
const lower = out.replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, "$1$2").toLowerCase();
const cssBodies = [...out.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n").toLowerCase();
for (const [label, needle] of [
  ["CSS: no remote URL", "evil.example"],
  ["CSS: no @import", "@import"],
  ["CSS: no expression()", "expression("],
  ["CSS: no behavior:", "behavior:"],
  ["CSS: no -moz-binding", "-moz-binding"],
  ["CSS: no raw <", "<"],
]) {
  assert(label, !cssBodies.includes(needle), `found "${needle}"`);
}

for (const [label, needle] of [
  ["no <script>", "<script"],
  ["no <iframe>", "<iframe"],
  ["no <object>", "<object"],
  ["no <embed>", "<embed"],
  ["no <form>", "<form"],
  ["no <input>", "<input"],
  ["no <link>", "<link"],
  ["no <base>", "<base"],
  ["no <foreignobject>", "<foreignobject"],
  ["no <template>", "<template"],
  ["no <noscript>", "<noscript"],
  ["no <animate>", "<animate"],
  ["no http-equiv", "http-equiv"],
  ["no javascript: anywhere", "javascript:"],
  ["no evil.example URL", "evil.example"],
  ["no @import", "@import"],
  ["no expression()", "expression("],
  ["no behavior:", "behavior:"],
  ["no -moz-binding", "-moz-binding"],
  ["no __pwned assignment", "__pwned"],
]) {
  assert(label, !lower.includes(needle), `found "${needle}"`);
}
assert("no on* event attribute in any tag", !/<[^>]*\son[a-z]+\s*=/i.test(out), out.match(/<[^>]*\son[a-z]+\s*=[^>]*>/i)?.[0]);
assert("no raw markup inside <style> (mXSS)", !/<style\b[^>]*>[^<]*<(?!\/style)/i.test(out));
assert("<a> kept without href", /<a>[\s\S]*click me/i.test(out) && !/<a[^>]*href/i.test(out));
assert("data: image kept", /<img[^>]*src="data:image\/png;base64/i.test(out));
assert("remote img src dropped (tag kept, no src)", /<img alt="remote image"\s*\/?>/i.test(out), out.match(/<img[^>]*remote image[^>]*>/i)?.[0]);
assert("data: url() in CSS kept", /background-image:\s*url\(data:image\/png/i.test(out));
assert("visible text preserved", out.includes("Batch No.: AVVS1122005") && out.includes("Origin: JORDAN"));
assert("svg shape kept", /<rect x="5" y="5" width="30" height="30" fill="#2a6"/i.test(out));
assert("doctype present", out.startsWith("<!DOCTYPE html>"));

console.log("\n🧪 sanitizeCss");
assert("remote url → data:,", sanitizeCss("a{b:url(http://x/y.png)}") === 'a{b:url("data:,")}', sanitizeCss("a{b:url(http://x/y.png)}"));
assert("quoted remote url → data:,", sanitizeCss("a{b:url('//x/y.png')}") === 'a{b:url("data:,")}');
assert("data url untouched", sanitizeCss("a{b:url('data:font/woff;base64,AAA')}") === "a{b:url('data:font/woff;base64,AAA')}");
assert("@import removed", !sanitizeCss('@import "x.css"; a{}').includes("@import"));

console.log("\n🧪 Line and page ids (§7.1)");
const pdfLike = sanitizeTemplateHtml(
  '<div class="pf w0" data-page-no="1"><div class="t m0 ff1">A</div><div class="t m0 ff1">B</div></div><div class="pf w0"><div class="t ff2">C</div></div>'
);
assert("page 1 id", /class="pf w0" data-page-no="1" data-page="1"/.test(pdfLike), pdfLike);
assert("lines are 1-based per page", pdfLike.includes('data-line="p1-l1"') && pdfLike.includes('data-line="p1-l2"') && pdfLike.includes('data-line="p2-l1"'));

console.log("\n🧪 Sanitized corpus in a real browser: nothing runs, nothing is fetched");
// 1) through the production renderer (network blocked there anyway)
const executed = await renderer.withDocument(out, (page) => page.evaluate(() => window.__pwned ?? null));
assert("renderer: no script executed", executed === null, executed);

// 2) a separate browser WITHOUT request blocking, to prove the document itself
//    requests nothing remote (the block is defence in depth, not the only line)
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
const requested = [];
await page.setRequestInterception(true);
page.on("request", (r) => {
  if (!/^(data|about):/.test(r.url())) requested.push(r.url());
  r.continue();
});
const dialogs = [];
page.on("dialog", (d) => {
  dialogs.push(d.message());
  d.dismiss();
});
await page.setContent(out, { waitUntil: "load" });
await page.mouse.move(50, 120);
await page.evaluate(() => document.querySelectorAll("*").forEach((el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }))));
await new Promise((r) => setTimeout(r, 300));
const pwned = await page.evaluate(() => window.__pwned ?? null);
await browser.close();
assert("unblocked browser: zero remote requests", requested.length === 0, requested);
assert("unblocked browser: no dialog", dialogs.length === 0, dialogs);
assert("unblocked browser: no script executed", pwned === null, pwned);

await renderer.shutdown();
await finish(counts);
