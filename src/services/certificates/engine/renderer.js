import fs from "fs";
import puppeteer from "puppeteer";

// Puppeteer renderer (CERTIFICATES_V2_PLAN.md §5.3) — the ONE place template
// and certificate HTML is laid out, measured, screenshotted and printed (D11).
//  - one browser per process, a small page pool, browser recycled after
//    RECYCLE_AFTER renders or on crash
//  - every request except data:/about: is aborted (no network, no file://)
//  - 30 s per operation
//  - the field engine is injected with page.evaluate(source) (plan §20 I4)

const ENGINE_SOURCE = fs.readFileSync(new URL("./fieldEngine.browser.js", import.meta.url), "utf8");
const POOL_SIZE = Number(process.env.RENDER_POOL_SIZE) || 2;
const RECYCLE_AFTER = Number(process.env.RENDER_RECYCLE_AFTER) || 200;
const OP_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS) || 30_000;

// Viewer-only reset (page container static, no margins/shadows). Injected for
// every operation and removed by serialize() — the stored document is never
// mutated for viewing. pdf2htmlEX's own print CSS is neutralised by emulating
// `screen` media for PDFs (P7).
export const VIEWER_RESET_CSS = `
html,body{margin:0!important;padding:0!important;background:#fff!important}
#sidebar,.loading-indicator{display:none!important}
#page-container{position:static!important;overflow:visible!important;background:none!important;top:auto!important;left:auto!important;bottom:auto!important;right:auto!important}
.pf{margin:0!important;box-shadow:none!important;border:0!important}`;

let browser = null;
let launching = null;
let rendersSinceLaunch = 0;
let active = 0;
const idlePages = [];
const waiters = [];

async function getBrowser() {
  if (browser && browser.connected) return browser;
  if (!launching) {
    launching = puppeteer
      .launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--font-render-hinting=none",
          "--disable-dev-shm-usage",
          // pooled pages are background tabs: without these, Chromium throttles
          // their rendering and a screenshot can wait forever for a frame
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--disable-backgrounding-occluded-windows",
        ],
      })
      .then((b) => {
        browser = b;
        rendersSinceLaunch = 0;
        b.on("disconnected", () => {
          if (browser === b) browser = null;
          idlePages.length = 0;
        });
        return b;
      })
      .finally(() => {
        launching = null;
      });
  }
  return launching;
}

async function newPage() {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (/^(data|about):/i.test(req.url())) req.continue();
    else req.abort("blockedbyclient");
  });
  await page.setJavaScriptEnabled(true); // only the injected engine ever runs — sanitized HTML has no scripts
  await page.setViewport({ width: 1200, height: 1200, deviceScaleFactor: 1 });
  page.setDefaultTimeout(OP_TIMEOUT_MS);
  return page;
}

// A recycle that is due "drains" the pool (review #16): no new page is handed
// out until the in-flight renders finish, then the browser is replaced. Without
// it, steady load kept `active` above 0 and the browser was never recycled.
let draining = false;
let recycles = 0;
let maxRendersPerBrowser = 0;

async function acquire() {
  while (active >= POOL_SIZE || draining) await new Promise((resolve) => waiters.push(resolve));
  active++;
  try {
    let page = idlePages.pop();
    if (!page || page.isClosed() || !browser || !browser.connected) page = await newPage();
    return page;
  } catch (err) {
    active--;
    await slotFreed(); // a drain may be waiting on exactly this slot
    throw err;
  }
}

let recycleRequested = false;

async function release(page, { broken = false, timedOut = false } = {}) {
  rendersSinceLaunch++;
  maxRendersPerBrowser = Math.max(maxRendersPerBrowser, rendersSinceLaunch);
  // never await closing a broken page — a wedged page can hang close() too
  if (broken || page.isClosed()) page.close().catch(() => {});
  else idlePages.push(page);
  if (timedOut) recycleRequested = true;
  active--;
  await slotFreed();
}

/** After `active--`: recycle if one is due and nothing is in flight, else hand the slot on. */
async function slotFreed() {
  if (!draining && browser && (recycleRequested || rendersSinceLaunch >= RECYCLE_AFTER)) draining = true;
  if (draining) {
    if (active > 0) return; // the last in-flight render does the recycle
    recycleRequested = false;
    if (browser) {
      const old = browser;
      browser = null;
      idlePages.length = 0;
      rendersSinceLaunch = 0;
      recycles++;
      await Promise.race([old.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
      old.process()?.kill("SIGKILL");
    }
    draining = false;
    // every waiter re-checks the pool in acquire(); waking more than POOL_SIZE is harmless
    for (const wake of waiters.splice(0)) wake();
    return;
  }
  waiters.shift()?.();
}

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Render timed out after ${OP_TIMEOUT_MS} ms (${label})`)), OP_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function load(page, html, { media = "screen" } = {}) {
  await page.emulateMediaType(media);
  await page.setContent(html, { waitUntil: "load", timeout: OP_TIMEOUT_MS });
  await page.evaluate(async (css) => {
    const st = document.createElement("style");
    st.setAttribute("data-engine", "viewer-reset");
    st.textContent = css;
    document.head.appendChild(st);
    await document.fonts.ready;
  }, VIEWER_RESET_CSS);
  await page.evaluate(ENGINE_SOURCE);
}

/**
 * Loads `html` into a pooled page (network blocked, engine injected) and runs
 * `fn(page)`. The page is returned to the pool afterwards; on error it is
 * discarded.
 */
export async function withDocument(html, fn, opts = {}) {
  const page = await acquire();
  let broken = false;
  let timedOut = false;
  try {
    return await withTimeout(
      (async () => {
        await load(page, html, opts);
        return fn(page);
      })(),
      opts.label || "render"
    );
  } catch (err) {
    broken = true;
    timedOut = /timed out/i.test(err.message);
    throw err;
  } finally {
    await release(page, { broken, timedOut });
  }
}

/** Calls window.__certEngine[name](...args) in the page. */
export const engine = (page, name, ...args) =>
  page.evaluate((n, a) => window.__certEngine[n](...a), name, args);

export const serialize = (page) => engine(page, "serialize");

/** Page rects in document coordinates (for screenshots / PDF). */
export function pageClips(page) {
  return page.evaluate(() => {
    // [data-page] after sanitizing; raw pdf2htmlEX output (only compared in tests) has bare .pf
    let els = Array.from(document.querySelectorAll("[data-page]"));
    if (!els.length) els = Array.from(document.querySelectorAll(".pf"));
    return els
      .map((el, i) => {
        const r = el.getBoundingClientRect();
        return { page: Number(el.getAttribute("data-page")) || i + 1, x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
      })
      .sort((a, b) => a.page - b.page);
  });
}

// Screenshots need the tab in front: a background tab may not produce a frame
// for seconds (or ever). They are short, so they are serialised process-wide.
let screenshotChain = Promise.resolve();
function exclusive(fn) {
  const run = screenshotChain.then(fn, fn);
  screenshotChain = run.catch(() => {});
  return run;
}

/** PNG screenshot of every page at `scale` (1 = 96 dpi). */
export function screenshotPagesOf(page, { scale = 1 } = {}) {
  return exclusive(async () => {
    await page.bringToFront();
    const clips = await pageClips(page);
    const out = [];
    for (const c of clips) {
      const png = await page.screenshot({
        type: "png",
        clip: { x: c.x, y: c.y, width: c.width, height: c.height, scale },
        captureBeyondViewport: true,
      });
      out.push({ page: c.page, png: Buffer.from(png), width: Math.round(c.width * scale), height: Math.round(c.height * scale) });
    }
    return out;
  });
}

/**
 * Prints a document to PDF (§5.3, P7/P8): `screen` media (load() emulates it,
 * neutralising pdf2htmlEX's print CSS), `@page` sized to the `.pf` rect with
 * no margin, one `.pf` per PDF page, backgrounds on, real selectable text.
 * → { pdf: Buffer, pages, widthPx, heightPx }
 */
export const printPdf = (html) =>
  withDocument(
    html,
    async (page) => {
      const clips = await pageClips(page);
      if (!clips.length) throw new Error("Nothing to print: the document has no page");
      const { width, height } = clips[0];
      await page.evaluate(
        (css) => {
          const st = document.createElement("style");
          st.setAttribute("data-engine", "print");
          st.textContent = css;
          document.head.appendChild(st);
        },
        `@page{size:${width}px ${height}px;margin:0}[data-page],.pf{break-after:page;page-break-after:always}[data-page]:last-of-type,.pf:last-of-type{break-after:auto;page-break-after:auto}`
      );
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      return { pdf: Buffer.from(pdf), pages: clips.length, widthPx: width, heightPx: height };
    },
    { label: "pdf" }
  );

export const analyse = (html) => withDocument(html, (page) => engine(page, "analyse"), { label: "analyse" });

export const screenshotPages = (html, opts) =>
  withDocument(html, (page) => screenshotPagesOf(page, opts), { label: "screenshot" });

/** SVG-background conversion (§7.8, plan §20 I26): cleans the SVG and rewrites cairo's blend filters → { html, stats }. */
export const normalizeBackground = (html, opts) =>
  withDocument(
    html,
    async (page) => {
      const stats = await engine(page, "normalizeBackground", opts || {});
      return { stats, html: stats.images ? await serialize(page) : html };
    },
    { label: "normalizeBackground" }
  );

/** For non-pdf2htmlEX HTML: marks body as page 1 and own-text elements as lines. */
export const markGenericLines = (html) =>
  withDocument(
    html,
    async (page) => {
      const res = await engine(page, "markGenericLines");
      return { ...res, html: res.marked ? await serialize(page) : html };
    },
    { label: "markGenericLines" }
  );

/** Closes the browser (tests, graceful worker shutdown). */
export async function shutdown() {
  const b = browser;
  browser = null;
  idlePages.length = 0;
  if (b) await b.close().catch(() => {});
}

export const rendererStats = () => ({ poolSize: POOL_SIZE, active, idle: idlePages.length, rendersSinceLaunch, connected: !!browser?.connected, draining, recycles, maxRendersPerBrowser, recycleAfter: RECYCLE_AFTER });
