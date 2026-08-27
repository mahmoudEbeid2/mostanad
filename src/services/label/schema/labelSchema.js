import { z } from "zod";

// The single source of truth for label content (MOSTANAD_ARCHITECTURE.md §6).
// Gemini's responseSchema (geminiSchema.js), deterministic validation
// (validation/schemaValidator.js), the patch-path allowlist, and API typing all
// derive from THIS file. If a field needs to be typed twice, the derivation is
// broken — fix the derivation, don't hand-write a second copy.

// §6.2 — the language primitive. Deliberately open (not a hardcoded {en,target}
// pair): required languages are a regulatory fact ("EG.VET.LANGUAGES.REQUIRED"),
// not a schema constant, so they belong in a RegulatoryRule (Phase 3), not here.
export const LocalizedText = z.object({
  translations: z.record(z.string().min(2).max(5), z.string().min(1)),
  primary: z.string(),
});

export const labelSchema = z.object({
  schemaVersion: z.literal("vet-label@2.0.0"),
  productType: z.enum(["veterinary_drug", "feed_additive", "premix", "supplement", "compound_feed"]),

  // Identity
  productName: LocalizedText,
  pharmaceuticalForm: LocalizedText.nullable(),
  strength: LocalizedText.nullable(),
  feedClassification: LocalizedText.nullable(),

  // Composition
  activeIngredients: z.array(z.object({
    translations: z.record(z.string(), z.string()),
    primary: z.string(),
    amount: z.string().min(1), // never empty — "q.s." if no quantity stated
    unit: z.string().nullable(),
    normalizedName: z.string().nullable(),
  })).min(1),
  excipients: z.array(LocalizedText).default([]),
  analysis: z.object({
    basis: z.string(), // "per 1 kg" | "per 1 L"
    items: z.array(z.object({ name: z.string(), value: z.string() })),
  }).nullable(),

  // Usage — targetAnimalSpecies is first-class
  targetAnimalSpecies: z.object({
    translations: z.record(z.string(), z.string()),
    primary: z.string(),
    list: z.array(z.string().min(1)).min(1),
    source: z.enum(["confirmed", "reference", "inferred"]), // computed in code, never by the model
  }),
  aimOfUse: LocalizedText,
  indications: z.array(LocalizedText).default([]),
  routeOfAdministration: LocalizedText.nullable(),
  directionOfUse: LocalizedText,
  contraindications: LocalizedText.nullable(),
  warnings: z.array(LocalizedText).default([]),
  sideEffects: LocalizedText.nullable(),
  withdrawalPeriod: LocalizedText.nullable(),
  userSafety: z.array(LocalizedText).default([]),

  // Handling
  storage: LocalizedText,
  shelfLifeAfterOpening: LocalizedText.nullable(),
  disposal: LocalizedText.nullable(),
  netWeight: LocalizedText,
  packaging: LocalizedText.nullable(),

  // Regulatory identity — real values, never booleans
  registrationNumber: z.string().nullable(),
  marketingAuthorisationHolder: LocalizedText.nullable(),
  manufacturer: LocalizedText.nullable(),
  importer: LocalizedText.nullable(),
  countryOfProduction: LocalizedText.nullable(),
  batchNo: z.string().nullable(),
  productionDate: z.string().nullable(),
  expiryDate: z.string().nullable(),
  prescriptionStatus: z.enum(["POM", "OTC", "VFD", "NA"]).default("NA"),

  // Declarations
  usageDeclaration: z.array(LocalizedText).default([]),
  keepOutOfReachOfChildren: z.boolean().default(true),

  estimatedFields: z.array(z.string()).default([]),
});
