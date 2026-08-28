import { GoogleGenAI } from "@google/genai";
import { MODELS } from "../../ai/modelRegistry.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// §14.2's exact agreement thresholds — pure, no AI needed to evaluate them.
export const AGREEMENT = {
  numeric: (values) => {
    const nums = values.map(extractNumber).filter((n) => n !== null);
    if (nums.length < values.length) return false; // any non-numeric run = disagreement
    const max = Math.max(...nums), min = Math.min(...nums);
    if (max === 0) return min === 0;
    return (max - min) / max <= 0.05;
  },
  set: (values) => {
    const sets = values.map((v) => new Set((Array.isArray(v) ? v : [v]).map((s) => (s || "").toString().toLowerCase().trim())));
    const [first, ...rest] = sets;
    return rest.every((s) => jaccard(first, s) >= 0.9);
  },
  categorical: (values) => new Set(values.map((v) => (v || "").toString().toLowerCase().trim())).size === 1,
};

function extractNumber(text) {
  const m = (text || "").toString().match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

function jaccard(a, b) {
  const intersection = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : intersection / union;
}

// §14.2's field list: numeric dosages, analysis values, strength, and anything
// tagged provenance "external" — never confirmed fields or descriptive prose.
export const RISKY_NUMERIC_FIELDS = ["directionOfUse", "strength"];

/**
 * Runs ONE field's generation 3 times at temperature 0.6 (§14.2 — deliberately
 * non-zero, to actually sample the model's uncertainty rather than getting the
 * same greedy output three times) and checks agreement. Real AI calls — 3 per
 * field checked, so this is NOT wired into every generation by default (see
 * PROGRESS.md's Phase 5 entry for the cost reasoning); it's a targeted,
 * separately-invokable check for specifically risky fields.
 */
export async function runSelfConsistency(prompt, { agreementFn = AGREEMENT.numeric, runs = 3 } = {}) {
  const results = await Promise.all(
    Array.from({ length: runs }, () =>
      ai.models.generateContent({
        model: MODELS.LABEL_GENERATE.id,
        contents: prompt,
        config: { temperature: 0.6 },
      }).then((r) => r.text)
    )
  );

  const agreed = agreementFn(results);
  return { agreed, runs: results, confidence: agreed ? "high" : "low" };
}
