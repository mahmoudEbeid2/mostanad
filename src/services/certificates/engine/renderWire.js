// Wire format between rendererClient and the cert-renderer service (plan §5.3).
// JSON both ways; Buffers (page PNGs, thumbnails) travel as { $b64: "…" } so a
// result keeps its in-process shape on the other side. PDFs are not JSON: the
// service streams them as application/pdf.

export const TOKEN_HEADER = "x-renderer-token";

export function encodeBuffers(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $b64: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encodeBuffers);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeBuffers(v)]));
  return value;
}

export function decodeBuffers(value) {
  if (Array.isArray(value)) return value.map(decodeBuffers);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$b64" && typeof value.$b64 === "string") return Buffer.from(value.$b64, "base64");
    return Object.fromEntries(keys.map((k) => [k, decodeBuffers(value[k])]));
  }
  return value;
}
