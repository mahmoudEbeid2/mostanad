// Review #16 — the pooled browser is recycled after RENDER_RECYCLE_AFTER renders
// even under sustained load. Before: the recycle only ran when the pool was
// momentarily idle (active === 0), which a steady queue never allows, so one
// browser served renders without bound. Now a due recycle drains the pool.
// No API, no database: renderer only.
process.env.RENDER_RECYCLE_AFTER = "3";
process.env.RENDER_POOL_SIZE = "2";
const { makeAssert } = await import("./helpers.js");
const renderer = await import("../../src/services/certificates/engine/renderer.js");

const { assert, counts } = makeAssert();
const html = (i) => `<!DOCTYPE html><html><head><title>t${i}</title></head><body><p>${i}</p></body></html>`;

let exitCode = 1;
try {
  console.log("\n🧪 24 renders, 8 at a time, pool 2, recycle after 3");
  const results = [];
  let next = 0;
  const lane = async () => {
    while (next < 24) {
      const i = next++;
      results[i] = await renderer.withDocument(html(i), (page) => page.evaluate(() => document.title), { label: `recycle-${i}` });
    }
  };
  await Promise.all(Array.from({ length: 8 }, lane));
  const stats = renderer.rendererStats();
  assert("every render succeeded, in order", results.length === 24 && results.every((t, i) => t === `t${i}`), results);
  assert("the browser was recycled repeatedly under load (≥ 5 times for 24 renders)", stats.recycles >= 5, stats);
  assert("no browser served more than limit + pool − 1 renders", stats.maxRendersPerBrowser <= stats.recycleAfter + stats.poolSize - 1, stats);
  assert("pool settled: nothing in flight, not draining", stats.active === 0 && stats.draining === false, stats);
  exitCode = counts.failed > 0 ? 1 : 0;
} finally {
  await renderer.shutdown();
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
  process.exit(exitCode);
}
