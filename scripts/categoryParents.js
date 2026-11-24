// Puts the existing categories under the client's five main ones (migration
// 20261124120000_category_parents added parent_id / sort_order and Premix).
//   node scripts/categoryParents.js           → prints the plan, changes nothing
//   node scripts/categoryParents.js --apply   → sets parent_id as planned
// Idempotent: a category already under the planned parent is left alone. A
// category whose name is not in MAPPING, or whose planned parent does not
// exist, is listed and left as it is. Nothing is renamed, merged or deleted.
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

// child name → main category name. Proposed 24 Nov; the owner approves it before --apply.
export const MAPPING = {
  "Feed Additive": "Feed Additives",
  "Natural Feed Additives": "Feed Additives",
  "Amino Acids": "Feed Additives",
  "Anticoccidial": "Feed Additives",
  "Broad-Spectrum Supplement": "Supplement",
  "Combination of Vitamins for Prevention and Stress Treatment": "Supplement",
  "Combination of Vitamins for Stress Treatment": "Supplement",
  "Dietetic Liquid Supplement": "Supplement",
  "Growth Promoter Supplement": "Supplement",
  "Immunomodulatory Feed Supplement": "Supplement",
  "Nutritional Feed Supplement": "Supplement",
};

const key = (s) => String(s).trim().toLowerCase();

/** → [{ id, name, from, to, toId, action: "set" | "keep" | "no_parent_found" | "not_mapped" | "main" }] */
export async function plan() {
  const all = await prisma.category.findMany({ select: { id: true, name: true, parentId: true, sortOrder: true }, orderBy: { name: "asc" } });
  const byName = new Map(all.map((c) => [key(c.name), c]));
  const byId = new Map(all.map((c) => [c.id, c]));
  const mapping = new Map(Object.entries(MAPPING).map(([c, p]) => [key(c), p]));
  return all.map((c) => {
    const from = c.parentId ? byId.get(c.parentId)?.name : null;
    if (c.sortOrder !== null) return { id: c.id, name: c.name, from, to: null, action: "main" };
    const to = mapping.get(key(c.name));
    if (!to) return { id: c.id, name: c.name, from, to: null, action: "not_mapped" };
    const parent = byName.get(key(to)) || (key(to) === "antibiotic" ? byName.get("antibiotics") : null);
    if (!parent) return { id: c.id, name: c.name, from, to, action: "no_parent_found" };
    return { id: c.id, name: c.name, from, to: parent.name, toId: parent.id, action: c.parentId === parent.id ? "keep" : "set" };
  });
}

export async function apply(rows) {
  let n = 0;
  for (const r of rows.filter((x) => x.action === "set")) {
    await prisma.category.update({ where: { id: r.id }, data: { parentId: r.toId } });
    n++;
  }
  return n;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file://${process.argv[1]}`) {
  const rows = await plan();
  for (const r of rows) console.log(`${r.action.padEnd(16)} ${r.name}${r.to ? ` → ${r.to}` : ""}${r.from && r.from !== r.to ? ` (now under ${r.from})` : ""}`);
  if (process.argv.includes("--apply")) console.log(`\n${await apply(rows)} categor(ies) moved under their main category.`);
  else console.log("\nNothing changed. Run with --apply to set these parents.");
  await prisma.$disconnect();
}
