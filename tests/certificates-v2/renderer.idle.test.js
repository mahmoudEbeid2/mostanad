// The pooled browser is not kept in memory between renders: it is launched on
// the first render, closed after CERT_BROWSER_IDLE_MS without one, and
// launched again by the next render. A render in flight is never cut off.
// No API, no database: renderer only.
process.env.CERT_BROWSER_IDLE_MS = "1500";
process.env.CERT_RENDER_PAGES = "1";
const { makeAssert } = await import("./helpers.js");
const renderer = await import("../../src/services/certificates/engine/renderer.js");

const { assert, counts } = makeAssert();
const html = (i) => `<!DOCTYPE html><html><head><title>t${i}</title></head><body><p>${i}</p></body></html>`;
const render = (i, fn = (page) => page.evaluate(() => document.title)) => renderer.withDocument(html(i), fn, { label: `idle-${i}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidOf = (page) => page.browser().process()?.pid;

let exitCode = 1;
try {
  console.log("\n🧪 Lazy launch");
  let s = renderer.rendererStats();
  assert("no browser before the first render", s.connected === false && s.idleCloseArmed === false, s);
  assert("env read: idle 1500 ms, 1 page", s.idleMs === 1500 && s.poolSize === 1, s);
  let pid1;
  const t0 = await render(0, async (page) => ((pid1 = pidOf(page)), page.evaluate(() => document.title)));
  s = renderer.rendererStats();
  assert("first render launches the browser and succeeds", t0 === "t0" && s.connected && pid1 > 0, s);
  assert("idle close armed once the pool is quiet", s.idleCloseArmed === true, s);

  console.log("\n🧪 Renders before the timeout keep the same browser");
  await sleep(800);
  let pidSame;
  await render(1, async (page) => ((pidSame = pidOf(page)), page.evaluate(() => document.title)));
  await sleep(800); // 1.6 s since the first render, 0.8 s since the last
  s = renderer.rendererStats();
  assert("a render re-arms the timer (still open 1.6 s after the first render)", s.connected && s.idleCloses === 0 && pidSame === pid1, { s, pid1, pidSame });

  console.log("\n🧪 A long render is never cut off by the idle timer");
  const long = await render(2, async (page) => (await sleep(2500), page.evaluate(() => document.title)));
  s = renderer.rendererStats();
  assert("a 2.5 s render (longer than the idle timeout) completes on its browser", long === "t2" && s.idleCloses === 0, s);

  console.log("\n🧪 Idle → closed");
  await sleep(2500);
  s = renderer.rendererStats();
  assert("browser closed after the idle timeout", s.connected === false && s.idleCloses === 1 && s.idleCloseArmed === false, s);
  let alive = true;
  try {
    process.kill(pid1, 0);
  } catch {
    alive = false;
  }
  assert("the Chromium process is gone", alive === false, { pid1 });
  assert("the recycle counter restarts with the next browser", s.rendersSinceLaunch === 0, s);

  console.log("\n🧪 Next render relaunches");
  let pid2;
  const t3 = await render(3, async (page) => ((pid2 = pidOf(page)), page.evaluate(() => document.title)));
  s = renderer.rendererStats();
  assert("next render relaunches a new browser and succeeds", t3 === "t3" && s.connected && pid2 > 0 && pid2 !== pid1, { s, pid1, pid2 });
  assert("idle close armed again", s.idleCloseArmed === true, s);
  exitCode = counts.failed > 0 ? 1 : 0;
} finally {
  await renderer.shutdown();
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
  process.exit(exitCode);
}
