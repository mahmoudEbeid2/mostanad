// What a tool result may look like by the time the model reads it: ids plus the
// fields it needs, never raw HTML / PDF / base64 / full document text, long
// strings cut, lists capped with how many more there are. Tools shape their own
// results (page() below); shapeResult is the safety net applied to every result.

export const MAX_ROWS = 25;
const MAX_STRING = 600;
const MAX_DEPTH = 7;
const DROP_KEY = /(html|base64|buffer|password|textContent|text_content|extractedText|fullText|thumbnail|bbox|geometry|svg|blob|fileBufferBase64|promptHash)$/i;
const BINARYISH = /^data:[^,]{0,80};base64,|^[A-Za-z0-9+/=\r\n]{2000,}$/;

export function shapeResult(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && typeof value.toNumber === "function" && "d" in value) return value.toNumber(); // Prisma Decimal
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return "[binary omitted]";
  if (typeof value === "string") {
    if (BINARYISH.test(value)) return "[binary omitted]";
    if (/<\/?(html|body|div|span|table|p)\b/i.test(value) && value.length > 200) return "[HTML omitted]";
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length - MAX_STRING} more characters)` : value;
  }
  if (typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ROWS).map((v) => shapeResult(v, depth + 1));
    if (value.length > MAX_ROWS) kept.push(`… ${value.length - MAX_ROWS} more not shown`);
    return kept;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROP_KEY.test(k) || v === undefined) continue;
    out[k] = shapeResult(v, depth + 1);
  }
  return out;
}

/** A page of rows for the model: { total, shown, more, nextPage?, items }. */
export function page(items, total, { page: p = 1, limit = 10 } = {}) {
  const shown = items.length;
  const before = (p - 1) * limit;
  const more = Math.max(0, (total ?? shown) - before - shown);
  return { total: total ?? shown, shown, more, ...(more > 0 ? { nextPage: p + 1 } : {}), items };
}

/** Pick only these keys (undefined/null dropped). */
export const pick = (o, keys) => (o ? Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]])) : null);

/** An entity reference the answer may link to. */
export const ref = (type, row, name = row?.name) => (row?.id ? { type, id: row.id, name: name ?? null } : null);
