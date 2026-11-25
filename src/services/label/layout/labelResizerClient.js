import AppError from "../../../utils/appError.js";

// Client for the label-resizer service (docker/label-resizer: Python + PyMuPDF),
// the resize that keeps a label's original design. Over HTTP like the
// cert-renderer: base64 in, base64 out; one request at a time on its side.
//   describe(pdf)            → { pageMm, pages, blocks, png (Buffer), original }
//   resize(pdf, { sizes… })  → [{ widthMm, heightMm, fit, mode, pdf (Buffer|null), png (Buffer), report }]
// Errors: 503 when the service is down or doesn't answer in time, 422 when it
// can't read the file (the reason is passed on).

const baseUrl = () => (process.env.LABEL_RESIZER_URL || "http://127.0.0.1:5080").replace(/\/$/, "");
const timeoutMs = () => Number(process.env.LABEL_RESIZER_TIMEOUT_MS) || 180_000;

async function call(path, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs());
  let res;
  let body;
  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.RESIZER_TOKEN) headers["x-resizer-token"] = process.env.RESIZER_TOKEN;
    res = await fetch(`${baseUrl()}${path}`, { method: "POST", headers, body: JSON.stringify(payload), signal: ctrl.signal });
    body = await res.json().catch(() => null);
  } catch (err) {
    throw new AppError(err.name === "AbortError" ? "Resizing the label took too long. Try again, or one size at a time." : `The label resize service isn't reachable (${err.cause?.code || err.message}).`, 503);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new AppError(`The label file couldn't be resized: ${body?.error || res.status}`, res.status === 400 || res.status === 422 ? 422 : 502);
  return body;
}

const buf = (b64) => (b64 ? Buffer.from(b64, "base64") : null);

export async function describe(pdf, { page = 0 } = {}) {
  const out = await call("/v1/describe", { pdf: pdf.toString("base64"), page });
  return { ...out, png: buf(out.png) };
}

export async function resize(pdf, { sizes, page = 0, minFontPt = 6, mode = "auto", bleedMm = 0, cropMarks = false, overrides = {} }) {
  const out = await call("/v1/resize", { pdf: pdf.toString("base64"), page, sizes, minFontPt, mode, bleedMm, cropMarks, overrides });
  return out.results.map((r) => ({ ...r, pdf: buf(r.pdf), png: buf(r.png) }));
}
