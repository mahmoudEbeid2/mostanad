import crypto from "crypto";

// Test-only authentication bypass (the `x-test-bypass` header, and the implicit
// NODE_ENV=test bypass). OFF unless explicitly opted in:
//   ALLOW_TEST_BYPASS=true  +  TEST_BYPASS_SECRET (≥ 16 chars, never hardcoded)
// `npm run dev:test` sets both (a fresh random secret per start); nothing else
// does. With NODE_ENV=production the app refuses to boot if ALLOW_TEST_BYPASS
// is set at all — this module throws at import, before the server listens.

const MIN_SECRET = 16;

/** → { enabled, secret } — throws for a configuration that must not boot. */
export function testBypassConfig(env = process.env) {
  const flag = env.ALLOW_TEST_BYPASS;
  if (flag && env.NODE_ENV === "production") {
    throw new Error("ALLOW_TEST_BYPASS is set while NODE_ENV=production — refusing to start. The test auth bypass must never run in production.");
  }
  if (flag !== "true") return { enabled: false, secret: null };
  const secret = env.TEST_BYPASS_SECRET || "";
  if (secret.length < MIN_SECRET) {
    throw new Error(`ALLOW_TEST_BYPASS=true needs TEST_BYPASS_SECRET (at least ${MIN_SECRET} characters) — refusing to start.`);
  }
  return { enabled: true, secret };
}

const config = testBypassConfig();

export const testBypassEnabled = config.enabled;

/** The request carries the configured bypass secret (constant-time compare). */
export function hasBypassHeader(req) {
  if (!config.enabled) return false;
  const sent = req.headers["x-test-bypass"];
  if (typeof sent !== "string") return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(config.secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Legacy NODE_ENV=test convenience: no header needed unless x-force-auth: true. */
export const isTestEnvBypass = (req) => config.enabled && process.env.NODE_ENV === "test" && req.headers["x-force-auth"] !== "true";

/** Either bypass applies to this request. */
export const isBypassed = (req) => hasBypassHeader(req) || isTestEnvBypass(req);
