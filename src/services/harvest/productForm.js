// A product's PHYSICAL form (Liquid, Powder, Injectable solution, Tablet…) vs what a document prints as its
// "Product Form" (29 Nov: ADDVET's COC prints "Product Form: Antibiotic" / "Supplement" — a category, which
// had become the products' physical form and printed in the HC's FORM column). Pure.

const FORM_WORDS = /\b(?:liquids?|solutions?|suspensions?|emulsions?|powders?|WSP|WP|granul(?:e|es|ate|ated)|tablets?|bol(?:us|uses|i)|capsules?|pastes?|gels?|creams?|ointments?|sprays?|aerosols?|pour[- ]?on|spot[- ]?on|premix(?:es)?|pellets?|crumbles?|syrups?|drops|concentrates?|lotions?|shampoos?|blocks?|licks?|implants?|crystals?|mash|flakes|oils?|meal)\b/i;

/** "LIQUID", "Injectable solution", "Water soluble powder" → true; "Antibiotic", "Supplement", "Injectable" → false */
export function isPhysicalForm(value) {
  const t = String(value ?? "").trim();
  return !!t && t.split(/\s+/).length <= 5 && FORM_WORDS.test(t);
}

// a result word a specification never holds (27 Nov QA: an unlabelled Identification row merged OLIGOVET's
// Appearance spec, its result and the next spec: "Light brown liquid Conforms Positive to HPLC test")
const RESULT_WORD = /[\s,;]*\b(?:Conforms?|Complies|Comply|Passes|Passed)\b/i;

/** a specification as a document printed it → the specification only (cut before a result word); "" when it is only a result */
export function cleanSpec(value) {
  const t = String(value ?? "").trim();
  const m = RESULT_WORD.exec(t);
  return m ? t.slice(0, m.index).trim() : t;
}

/** a harvested "physicalForm" fact → the product column it belongs to: physicalForm, or productForm (a document's label) */
export const formColumnOf = (value) => (isPhysicalForm(value) ? "physicalForm" : "productForm");
