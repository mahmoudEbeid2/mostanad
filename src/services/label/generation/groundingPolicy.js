// CLAUDE.md invariant #5 / §8.2's absolute exclusions. These fields may NEVER
// be filled from model knowledge or unconfirmed external lookup — Tier 1
// (Product row), Tier 2 (user hint), or Tier 4 (a matched reference) only.
// Empty + FAIL beats a plausible-looking guess: a wrong withdrawal period or
// strength is a direct human/animal safety risk, and a fabricated registration
// number is forging an official document.
export const NEVER_GUESS_FIELDS = [
  "withdrawalPeriod",
  "strength",
  "activeIngredients[].amount",
  "registrationNumber",
  "batchNo",
  "expiryDate",
];

export const isNeverGuessField = (fieldPath) => NEVER_GUESS_FIELDS.includes(fieldPath);
