// CLAUDE.md item 2/3: 429 and 503 are not the same failure and must not be
// handled the same way, and the real Google error must never be swallowed
// behind a generic "API busy" string. This is the one place that parses a
// thrown @google/genai error into something a retry loop and a human can both
// act on.

/**
 * @google/genai throws errors whose `.message` is frequently the raw REST
 * error body as a JSON string (sometimes with an "got status X" prefix, since
 * the SDK doesn't guarantee a stable shape across transports). We recover:
 *   - httpStatus: the numeric HTTP status (429, 503, ...)
 *   - googleMessage: Google's own human-readable message, not our wrapper text
 *   - retryDelayMs: honoured RetryInfo.retryDelay when Google sent one
 *   - quotaScope: "per_minute" | "daily" | "unknown" | null (null = not a quota error)
 */
export function parseGeminiError(error) {
  const rawMessage = error?.message ?? String(error);

  let httpStatus = typeof error?.status === "number" ? error.status : typeof error?.code === "number" ? error.code : null;
  let googleMessage = rawMessage;
  let details = [];

  const jsonStart = rawMessage.indexOf("{");
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(rawMessage.slice(jsonStart));
      const body = parsed.error ?? parsed;
      if (typeof body.code === "number") httpStatus = body.code;
      if (typeof body.message === "string") googleMessage = body.message;
      if (Array.isArray(body.details)) details = body.details;
    } catch {
      // Not JSON (or truncated) — fall back to the raw message string below.
    }
  }

  if (httpStatus === null) {
    if (rawMessage.includes("429")) httpStatus = 429;
    else if (rawMessage.includes("503") || rawMessage.includes("Service Unavailable")) httpStatus = 503;
  }

  const retryInfo = details.find((d) => typeof d["@type"] === "string" && d["@type"].includes("RetryInfo"));
  let retryDelayMs = null;
  if (retryInfo?.retryDelay) {
    const match = /^([\d.]+)s$/.exec(retryInfo.retryDelay);
    if (match) retryDelayMs = Math.ceil(parseFloat(match[1]) * 1000);
  }

  let quotaScope = null;
  if (httpStatus === 429) {
    const quotaFailure = details.find((d) => typeof d["@type"] === "string" && d["@type"].includes("QuotaFailure"));
    const ids = (quotaFailure?.violations ?? []).map((v) => `${v.quotaId || ""} ${v.quotaMetric || ""}`).join(" ");
    if (/per.?day/i.test(ids) || /per.?day/i.test(googleMessage)) quotaScope = "daily";
    else if (/per.?minute/i.test(ids) || /per.?minute/i.test(googleMessage)) quotaScope = "per_minute";
    else quotaScope = "unknown";
  }

  return { httpStatus, googleMessage, retryDelayMs, quotaScope, rawMessage };
}
