// Characters that may be swapped when the design font lacks one but has its exact
// typographic equivalent. Only the rendered text changes, never the stored value.
// This list is the whole rule: × ↔ x and ° ↔ º change the meaning and must stay out,
// and digits, signs (+ − ±), units and letters are never swapped.
export const LOOK_ALIKES = {
  " ": [" "], // non-breaking space
  "‘": ["'"], // ‘
  "’": ["'"], // ’
  "“": ['"'], // “
  "”": ['"'], // ”
  "–": ["-"], // –
  "—": ["-"], // —
  "µ": ["μ"], // micro sign → Greek mu
  "μ": ["µ"], // Greek mu → micro sign
};

/** The equivalent of `ch` the font has, or null. `covered` is the font's Set of characters. */
export const lookAlikeFor = (ch, covered) => (Object.hasOwn(LOOK_ALIKES, ch) && LOOK_ALIKES[ch].find((alt) => covered.has(alt))) || null;
