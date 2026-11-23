import { fieldKeyOf } from "../i18n.js";

// A value the model gave for a draft field, read into the shape the field's own schema
// wants — leniently in FORM (5 → "5", "1" → 1, { amount: 5, unit: "days" } → "5 days",
// an Arabic field name → its key), never in CONTENT: nothing is invented, and a text the
// person wrote ("5 ايام") is preferred over a rendering of it, so the draft's "the
// person's own words" check still holds. QA 2026-11-23: start_draft refused numbers and
// objects ("expected string, received number") and the model retried until the call
// budget ran out.

const UNITS_AR = { day: "يوم|ايام|أيام", days: "يوم|ايام|أيام", hour: "ساعه|ساعة|ساعات", hours: "ساعه|ساعة|ساعات", week: "اسبوع|أسبوع|اسابيع", weeks: "اسبوع|أسبوع|اسابيع", month: "شهر|شهور|اشهر", months: "شهر|شهور|اشهر" };

/** { amount, unit } / { value, unit } → the person's own phrase for it when they wrote one ("5 ايام"), else "5 days". */
function quantityText(v, userTexts = []) {
  const amount = v.amount ?? v.value ?? v.quantity;
  const unit = String(v.unit ?? v.units ?? "").trim();
  const n = String(amount).trim();
  const alt = UNITS_AR[unit.toLowerCase()];
  const re = new RegExp(`(?<![\\d.])${n.replace(/\./g, "\\.")}\\s*(?:${[unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), alt].filter(Boolean).join("|")})`, "i");
  for (const t of userTexts) {
    const m = re.exec(String(t));
    if (m) return m[0];
  }
  return `${n}${unit ? ` ${unit}` : ""}`;
}
const isQuantity = (v) => v && typeof v === "object" && !Array.isArray(v) && ("amount" in v || "value" in v || "quantity" in v) && ("unit" in v || "units" in v) && Object.keys(v).length <= 3;

const typeOf = (schema) => schema?._zod?.def?.type;
const inner = (schema) => {
  let s = schema;
  for (let i = 0; i < 6 && ["optional", "nullable", "default", "readonly", "catch", "prefault"].includes(typeOf(s)); i++) s = s._zod.def.innerType;
  return s;
};

/** value → coerced to `schema` (zod 4) where the form allows it. Unknown shapes are returned as they are (the schema then says what's wrong). */
export function coerceToSchema(schema, value, userTexts = []) {
  const s = inner(schema);
  const t = typeOf(s);
  if (value === null || value === undefined) return value;
  if (t === "string" || t === "enum") {
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (isQuantity(value)) return quantityText(value, userTexts);
    if (typeof value === "string" && /^\s*\{/.test(value) && isQuantity(tryJson(value))) return quantityText(tryJson(value), userTexts);
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && ["text", "value"].includes(Object.keys(value)[0])) return coerceToSchema(schema, Object.values(value)[0], userTexts);
    return value;
  }
  if (t === "number" || t === "int") {
    if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
    if (isQuantity(value) && typeof (value.amount ?? value.value) === "number") return value.amount ?? value.value;
    return value;
  }
  if (t === "boolean") {
    if (value === "true" || value === "false") return value === "true";
    return value;
  }
  if (t === "array") {
    const arr = typeof value === "string" ? tryJson(value) : value;
    if (!Array.isArray(arr)) return isPlainObject(arr) ? [coerceToSchema(s._zod.def.element, arr, userTexts)] : value;
    return arr.map((x) => coerceToSchema(s._zod.def.element, x, userTexts));
  }
  if (t === "object") {
    const obj = typeof value === "string" ? tryJson(value) : value;
    if (!isPlainObject(obj)) return value;
    const shape = s._zod.def.shape || {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = shape[k] ? coerceToSchema(shape[k], v, userTexts) : v;
    // update_product_fields' { field, value }: an Arabic or spaced field name → its key
    if (typeof out.field === "string" && shape.field) {
      const key = fieldKeyOf(out.field);
      if (key && !shape.field.safeParse(out.field).success && shape.field.safeParse(key).success) out.field = key;
    }
    return out;
  }
  if (t === "union") {
    for (const opt of s._zod.def.options) {
      const c = coerceToSchema(opt, value, userTexts);
      if (opt.safeParse(c).success) return c;
    }
    return value;
  }
  if (t === "record") {
    const obj = typeof value === "string" ? tryJson(value) : value;
    if (!isPlainObject(obj)) return value;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, coerceToSchema(s._zod.def.valueType, v, userTexts)]));
  }
  return value;
}
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
