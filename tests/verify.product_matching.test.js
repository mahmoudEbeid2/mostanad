import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.js";
import { matchProduct } from "../src/services/label/retrieval/productMatcher.js";

// §14.5.1 (item 1): product matching used to be an unscoped "most recent
// product sharing ANY single ingredient" query — how a 2-active oral liquid
// matched a 30-active powder. It must now reuse the weighted similarity
// generation retrieval already has (similarity.js) and be tenant-scoped.

const VETAMINO_30_ACTIVES = {
  id: "vetamino-1",
  name: "VETAMINO",
  companyId: "company-a",
  dosageForm: "powder",
  physicalForm: "powder",
  strength: "3.75 IU/g",
  routeOfAdmin: "oral",
  targetSpecies: ["Poultry"],
  indications: null,
  activeIngredients: [
    { name: "Vitamin E", concentration: "3.75 IU/g" },
    ...Array.from({ length: 29 }, (_, i) => ({ name: `Filler ${i}`, concentration: "1%" })),
  ],
};

const ADD_E120_MATCH = {
  id: "adde120-1",
  name: "ADD-E120",
  companyId: "company-a",
  dosageForm: "oral liquid",
  physicalForm: "liquid",
  strength: "120000 mg/L",
  routeOfAdmin: "oral",
  targetSpecies: ["Poultry"],
  indications: null,
  activeIngredients: [
    { name: "Vitamin E", concentration: "120000 mg/L" },
    { name: "Sodium Selenite", concentration: "60 mg/L" },
  ],
};

const extractedAddE120 = () => ({
  productName: "ADD-E120",
  pharmaceuticalForm: "oral liquid",
  strength: "120000 mg/L",
  routeOfAdministration: "oral",
  targetAnimalSpeciesList: ["Poultry"],
  aimOfUse: "Vitamin supplementation",
  activeIngredients: [
    { name: "Vitamin E", concentration: "120000 mg/L" },
    { name: "Sodium Selenite", concentration: "60 mg/L" },
  ],
});

function stubProducts(products) {
  const calls = [];
  const original = prisma.product;
  prisma.product = {
    findMany: async (args) => {
      calls.push(args);
      return products.filter((p) => !args?.where?.companyId || p.companyId === args.where.companyId);
    },
  };
  return { calls, restore: () => { prisma.product = original; } };
}

test("§14.5.1 a 2-active liquid does not match-state a 30-active powder", async () => {
  const { restore } = stubProducts([VETAMINO_30_ACTIVES]);
  try {
    const result = await matchProduct(extractedAddE120(), "Saudi Arabia", "company-a");
    assert.notEqual(result.matchState, "matched", "must not be treated as the same product");
  } finally {
    restore();
  }
});

test("§14.5.1 exact name match is 'matched'", async () => {
  const { restore } = stubProducts([VETAMINO_30_ACTIVES, ADD_E120_MATCH]);
  try {
    const result = await matchProduct(extractedAddE120(), "Saudi Arabia", "company-a");
    assert.equal(result.matchState, "matched");
    assert.equal(result.dbProduct.id, "adde120-1");
  } finally {
    restore();
  }
});

const ADD_E120_DIFFERENT_STRENGTH = {
  id: "adde120-variant",
  name: "ADD-E120 FORTE",
  companyId: "company-a",
  dosageForm: "oral liquid",
  physicalForm: "liquid",
  strength: "12000 mg/L", // same ingredients, 10x the strength — not the same product
  routeOfAdmin: "oral",
  targetSpecies: ["Poultry"],
  indications: null,
  activeIngredients: [
    { name: "Vitamin E", concentration: "12000 mg/L" },
    { name: "Sodium Selenite", concentration: "6 mg/L" },
  ],
};

test("§14.5.1 (item 4) a same-ingredient, different-strength candidate is 'similar', not 'matched'", async () => {
  const { restore } = stubProducts([ADD_E120_DIFFERENT_STRENGTH]);
  try {
    const result = await matchProduct(extractedAddE120(), "Saudi Arabia", "company-a");
    assert.equal(result.matchState, "similar", "a scored-but-not-exact candidate must be the middle state, not matched or none");
    assert.equal(result.dbProduct.id, "adde120-variant");
  } finally {
    restore();
  }
});

test("§14.5.1 no candidates at all reports 'none', not a false match", async () => {
  const { restore } = stubProducts([]);
  try {
    const result = await matchProduct(extractedAddE120(), "Saudi Arabia", "company-a");
    assert.equal(result.matchState, "none");
    assert.equal(result.dbProduct, null);
  } finally {
    restore();
  }
});

test("§14.5.1 (Invariant #10) query is always scoped to the caller's companyId", async () => {
  const { calls, restore } = stubProducts([VETAMINO_30_ACTIVES]);
  try {
    await matchProduct(extractedAddE120(), "Saudi Arabia", "company-a");
    assert.ok(calls.length > 0, "findMany must have been called");
    assert.equal(calls[0].where.companyId, "company-a", "the tenant filter must be present on the query");
  } finally {
    restore();
  }
});

test("§14.5.1 no companyId never falls back to a global search", async () => {
  const { calls, restore } = stubProducts([VETAMINO_30_ACTIVES, ADD_E120_MATCH]);
  try {
    const result = await matchProduct(extractedAddE120(), "Saudi Arabia", null);
    assert.equal(result.matchState, "none");
    assert.equal(calls.length, 0, "must not query at all without a tenant");
  } finally {
    restore();
  }
});
