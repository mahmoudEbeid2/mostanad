import { z } from "zod";
import AppError from "../../../utils/appError.js";

// Printable label layout (owner request 2026-11-23: "same label, other
// dimensions"). A layout is page size + margins + which sections print, in which
// order, + type rules; the content always comes from the label's labelData.
// The renderer lays it out at the exact page size (mm) and auto-fits: the font
// shrinks step by step down to minFontPt, then 2 columns are tried, then what
// still doesn't fit is REPORTED per section — text is never cut and never set
// below the minimum.

/** Common label sizes, width × height in mm (portrait). */
export const SIZE_PRESETS = [
  { key: "100x150", label: "10 × 15 cm", widthMm: 100, heightMm: 150 },
  { key: "100x120", label: "10 × 12 cm", widthMm: 100, heightMm: 120 },
  { key: "100x100", label: "10 × 10 cm", widthMm: 100, heightMm: 100 },
  { key: "70x100", label: "7 × 10 cm", widthMm: 70, heightMm: 100 },
  { key: "60x90", label: "6 × 9 cm", widthMm: 60, heightMm: 90 },
  { key: "50x80", label: "5 × 8 cm", widthMm: 50, heightMm: 80 },
  { key: "40x60", label: "4 × 6 cm", widthMm: 40, heightMm: 60 },
];

/** Sections in their default priority order (top of the label first). */
export const SECTION_KEYS = ["productName", "composition", "indications", "dosage", "withdrawal", "storage", "warnings", "registration", "batch", "company"];
export const SECTION_TITLES = {
  en: { productName: "Product name", composition: "Composition", indications: "Indications", dosage: "Dosage & administration", withdrawal: "Withdrawal period", storage: "Storage", warnings: "Warnings", registration: "Registration No.", batch: "Batch / expiry", company: "Manufacturer" },
  ar: { productName: "اسم المنتج", composition: "التركيب", indications: "دواعي الاستعمال", dosage: "الجرعة وطريقة الاستعمال", withdrawal: "فترة السحب", storage: "التخزين", warnings: "تحذيرات", registration: "رقم التسجيل", batch: "التشغيلة / الصلاحية", company: "الشركة المصنعة" },
};

export const DEFAULT_MIN_FONT_PT = 6;
export const DEFAULT_LAYOUT = {
  widthMm: 100,
  heightMm: 150,
  orientation: "portrait",
  marginsMm: { top: 4, right: 4, bottom: 4, left: 4 },
  sections: SECTION_KEYS.map((key) => ({ key, enabled: true })),
  fontFamily: "Arial, 'Noto Sans Arabic', 'Noto Naskh Arabic', 'Segoe UI', sans-serif",
  startFontPt: 9,
  minFontPt: DEFAULT_MIN_FONT_PT,
  maxColumns: 2,
};

const mm = (min, max) => z.number().finite().min(min).max(max);
export const layoutInput = z.object({
  preset: z.string().max(20).optional(),
  widthMm: mm(20, 400).optional(),
  heightMm: mm(20, 400).optional(),
  orientation: z.enum(["portrait", "landscape"]).optional(),
  marginsMm: z.object({ top: mm(0, 30), right: mm(0, 30), bottom: mm(0, 30), left: mm(0, 30) }).partial().optional(),
  sections: z.array(z.object({ key: z.enum(SECTION_KEYS), enabled: z.boolean().default(true) })).max(SECTION_KEYS.length).optional(),
  fontFamily: z.string().max(200).regex(/^[\w\s,'"-]+$/, "Font family: letters, spaces, commas and quotes only").optional(),
  startFontPt: z.number().min(4).max(24).optional(),
  minFontPt: z.number().min(4).max(16).optional(),
  maxColumns: z.number().int().min(1).max(3).optional(),
});

/**
 * Input (+ the layout it starts from) → a complete layout. A preset sets the
 * size; explicit widthMm/heightMm win over it; landscape swaps them so width ≥ height.
 */
export function resolveLayout(input = {}, base = DEFAULT_LAYOUT) {
  const parsed = layoutInput.safeParse(input || {});
  if (!parsed.success) throw new AppError(`Invalid layout: ${parsed.error.issues.map((i) => `${i.path.join(".") || "layout"}: ${i.message}`).join("; ")}`, 400);
  const a = parsed.data;
  const preset = a.preset ? SIZE_PRESETS.find((p) => p.key === a.preset) : null;
  if (a.preset && !preset) throw new AppError(`Unknown size preset "${a.preset}". Presets: ${SIZE_PRESETS.map((p) => p.key).join(", ")}`, 400);
  let widthMm = a.widthMm ?? preset?.widthMm ?? base.widthMm;
  let heightMm = a.heightMm ?? preset?.heightMm ?? base.heightMm;
  // an explicit orientation turns the page; otherwise it follows the size given
  if (a.orientation && widthMm !== heightMm && (a.orientation === "landscape") !== widthMm > heightMm) [widthMm, heightMm] = [heightMm, widthMm];
  const orientation = widthMm > heightMm ? "landscape" : "portrait";
  const marginsMm = { ...DEFAULT_LAYOUT.marginsMm, ...(base.marginsMm || {}), ...(a.marginsMm || {}) };
  if (marginsMm.left + marginsMm.right >= widthMm - 10 || marginsMm.top + marginsMm.bottom >= heightMm - 10) throw new AppError("The margins leave no room for the label's text", 400);
  // every section appears once: the given order first, then any left out (disabled)
  const given = a.sections ?? base.sections ?? DEFAULT_LAYOUT.sections;
  const seen = new Set(given.map((s) => s.key));
  const sections = [...given.map((s) => ({ key: s.key, enabled: s.enabled !== false })), ...SECTION_KEYS.filter((k) => !seen.has(k)).map((key) => ({ key, enabled: !a.sections }))];
  const minFontPt = a.minFontPt ?? base.minFontPt ?? DEFAULT_MIN_FONT_PT;
  const startFontPt = Math.max(a.startFontPt ?? base.startFontPt ?? DEFAULT_LAYOUT.startFontPt, minFontPt);
  return {
    widthMm: round1(widthMm),
    heightMm: round1(heightMm),
    orientation,
    marginsMm,
    sections,
    fontFamily: a.fontFamily ?? base.fontFamily ?? DEFAULT_LAYOUT.fontFamily,
    startFontPt,
    minFontPt,
    maxColumns: a.maxColumns ?? base.maxColumns ?? DEFAULT_LAYOUT.maxColumns,
  };
}
const round1 = (n) => Math.round(n * 10) / 10;
export const sizeLabel = (l) => `${fmtCm(l.widthMm)} × ${fmtCm(l.heightMm)} cm`;
const fmtCm = (v) => String(Math.round(v) / 10).replace(/\.0$/, "");
