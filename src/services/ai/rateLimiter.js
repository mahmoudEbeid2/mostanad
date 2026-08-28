// Process-wide Gemini call gate (CLAUDE.md "SHARED RATE LIMITER"). One instance
// lives inside geminiClient and every caller — every worker, every service —
// goes through it, because they all share one API key and one quota.
//
// Real token bucket: capacity == GEMINI_RPM, refills continuously (capacity
// tokens per 60s), so a burst up to the full RPM is allowed and then throttled
// smoothly rather than let one caller spend the whole minute's budget upfront.
// A separate, independent cap (GEMINI_MAX_CONCURRENT) bounds simultaneous
// in-flight requests regardless of how many tokens are available — thinking
// calls can take tens of seconds, and without this a token refund the instant
// a slot frees up would let dozens of long calls pile up together.
//
// Callers queue (FIFO) instead of being rejected — that is the actual fix:
// nothing here throws for being over budget, it just makes the caller wait.
export class GeminiRateLimiter {
  constructor({ requestsPerMinute, maxConcurrent }) {
    if (!(requestsPerMinute > 0)) throw new Error("GeminiRateLimiter: requestsPerMinute must be > 0");
    if (!(maxConcurrent > 0)) throw new Error("GeminiRateLimiter: maxConcurrent must be > 0");

    this.capacity = requestsPerMinute;
    this.tokens = requestsPerMinute; // start full — don't punish the first burst after boot
    this.refillPerMs = requestsPerMinute / 60_000;
    this.lastRefill = Date.now();

    this.maxConcurrent = maxConcurrent;
    this.inFlight = 0;

    this.queue = []; // FIFO of { resolve }
    this._timer = null;
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  /** Resolves once a slot is free. Always paired with release(). */
  acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._drain();
    });
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this._drain();
  }

  _drain() {
    if (this.queue.length === 0) return;
    this._refill();

    if (this.inFlight < this.maxConcurrent && this.tokens >= 1) {
      this.tokens -= 1;
      this.inFlight += 1;
      const resolve = this.queue.shift();
      resolve();
      if (this.queue.length > 0) this._drain();
      return;
    }

    if (this._timer) return; // a wakeup is already scheduled
    const msUntilNextToken = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs);
    const wait = this.inFlight >= this.maxConcurrent ? Math.max(msUntilNextToken, 100) : Math.max(msUntilNextToken, 10);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._drain();
    }, wait);
  }

  /** For logging/metrics — not load-bearing. */
  snapshot() {
    this._refill();
    return { tokens: Math.floor(this.tokens), capacity: this.capacity, inFlight: this.inFlight, queued: this.queue.length };
  }
}
