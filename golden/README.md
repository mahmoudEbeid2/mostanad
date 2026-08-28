# Golden Set

Real ground truth for measuring label-generation accuracy (MOSTANAD_ARCHITECTURE.md
§14.3, Phase 0.5). `scripts/evalGolden.js` runs every case directory here through
the live generation pipeline and scores the result field by field against what a
human actually approved.

**Two directories are checked in — `001-synthetic-amoxicillin-poultry` and
`002-synthetic-vitamin-cattle` — with made-up input/expected data, so the harness
itself is provably runnable before real data exists. They are NOT real approvals.
Do not use their `overallAccuracy` numbers to judge the system — replace them (or
add 28 more directories alongside them) with real cases before trusting the score.**

## What to put in each case

Create one directory per real approved label, named however you like (a short
slug is easiest to scan, e.g. `003-amoxicillin-broiler-eg`). Each needs exactly
three files:

### `input.json` — exactly what the user typed to request this label

The literal request body for `POST /reference-labels/generate-text-ai`:

```json
{
  "formulationText": "the raw formulation text the user pasted in",
  "country": "Egypt",
  "language": "ar",
  "aimOfUseHint": "the confirmed indication, if the user gave one",
  "targetSpeciesHint": "the confirmed target species, if the user gave one",
  "directionOfUseHint": "the confirmed dosage, if the user gave one"
}
```

`companyId` is intentionally NOT part of this file — `evalGolden.js` provisions
its own sandbox company (`Golden Set Eval Co`) and injects it automatically, so
these fixtures stay portable across databases. If a real case genuinely needs a
specific company's reference labels to reproduce, say so in a comment in this
README when you add it, not by hardcoding an id here.

### `expected.json` — the label a human actually approved for this input

Must match the shape the CURRENT generator actually outputs today (this is the
pre-Phase-4 ad-hoc shape, not yet `labelSchema`'s — see `PROGRESS.md`'s Phase 2
entry). That's:

```json
{
  "productName": { "en": "...", "target": "..." },
  "feedClassification": { "en": "...", "target": "..." },
  "ingredients": [{ "en": "...", "target": "...", "amount": "..." }],
  "analysis": { "basis": "per 1 kg", "items": [{ "name": "...", "value": "..." }] },
  "aimOfUse": { "en": "...", "target": "..." },
  "targetAnimalSpecies": { "en": "...", "target": "..." },
  "directionOfUse": { "en": "...", "target": "..." },
  "storage": { "en": "...", "target": "..." },
  "netWeight": { "en": "...", "target": "..." },
  "usageDeclaration": [{ "en": "...", "target": "..." }]
}
```

Use the label EXACTLY as it was approved, in this shape — don't paraphrase or
"clean it up." If a field genuinely doesn't apply to this product, set it to
`null` and the scorer will report `notApplicable` for it, not `wrong`.

**Known gap you'll hit later:** once Phase 4 makes generation actually conform
to `labelSchema` (§6.3), this expected.json shape will need to migrate too
(`LocalizedText.translations{}` instead of `{en,target}`, plus the fields that
don't exist in today's generator at all — `withdrawalPeriod`,
`routeOfAdministration`, `registrationNumber`, etc.). When that happens, re-derive
every case's `expected.json` from the same source approvals in the new shape —
don't hand-guess it.

### `tolerances.json` — what counts as "close enough" for THIS case

```json
{
  "targetAnimalSpecies": {
    "synonyms": { "poultry": ["chicken", "broiler", "layer", "hen"] }
  },
  "directionOfUse": {
    "numericTolerancePercent": 5
  }
}
```

Only add entries for fields where a literal string match is too strict. Leave it
`{}` if exact/word-overlap matching (see `scripts/evalGolden.js`'s `compareField`)
is good enough for this case.

## Running it

Requires the server AND `labelGeneratorWorker.js` already running (same
convention as `tests/*.test.js` — this harness doesn't start them for you), plus
`GEMINI_API_KEY` with quota available (each case makes one real generation call).

```bash
npm run eval:golden
```

Prints a field-by-field accuracy table, persists the run to `GoldenEvalRun`, and
compares against the previous run — a >2% drop on ANY field blocks the change
(CLAUDE.md invariant #11) and the script exits non-zero.

## Limits (§14.3's own caveat, worth repeating)

30 cases is statistically thin. A 2% swing on some fields will be within noise.
Still — without this, every "the new prompt is better" claim is a guess.
