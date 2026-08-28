import crypto from "crypto";

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

function fingerprintFor(labelData, country) {
  const ingredientsKey = (labelData.activeIngredients || [])
    .map((i) => `${i.normalizedName || i.primary}:${i.amount}`)
    .sort()
    .join("|");
  const formKey = labelData.pharmaceuticalForm?.translations?.[labelData.pharmaceuticalForm.primary] || "";
  const speciesKey = (labelData.targetAnimalSpecies?.list || []).slice().sort().join(",");
  return sha256([ingredientsKey, formKey, speciesKey, country].join("::"));
}

function renderPlainText(labelData) {
  const text = (lt) => (lt ? lt.translations?.[lt.primary] || Object.values(lt.translations || {})[0] || "" : "");
  return [
    text(labelData.productName),
    text(labelData.feedClassification),
    (labelData.activeIngredients || []).map((i) => `${i.translations?.[i.primary] || ""} ${i.amount || ""}`).join(", "),
    text(labelData.aimOfUse),
    text(labelData.directionOfUse),
    text(labelData.storage),
  ].filter(Boolean).join("\n");
}

function extractIndicationTags(labelData) {
  const fromIndications = (labelData.indications || []).map((i) => i.translations?.en).filter(Boolean);
  if (fromIndications.length > 0) return fromIndications;
  const aimText = labelData.aimOfUse?.translations?.en;
  return aimText ? [aimText] : [];
}

/**
 * §12.3's promotion — a real, unabridged reference from a human-approved
 * label. Zero AI extraction cost: the label's own labelData already IS
 * structured. `embedding` (pgvector) is deliberately not set — see the
 * ReferenceLabel §5.9 extension's own comment; same volume gate as Phase 4.
 */
export async function promoteToReference(tx, label, approval, scope) {
  const d = label.labelData;
  const fingerprint = fingerprintFor(d, label.country);

  const existing = await tx.referenceLabel.findFirst({
    where: { fingerprint, companyId: label.companyId, isApproved: true },
  });
  if (existing) {
    await tx.referenceLabel.update({ where: { id: existing.id }, data: { isApproved: false, supersededById: null } });
  }

  let brandId = null;
  if (label.productId) {
    const product = await tx.product.findUnique({ where: { id: label.productId }, select: { brandId: true } });
    brandId = product?.brandId || null;
  }

  const productName = d.productName?.translations?.[d.productName.primary] || "Untitled";
  const reference = await tx.referenceLabel.create({
    data: {
      name: `${productName} — approved ${approval.approvedAt.toISOString().slice(0, 10)}`,
      sourceType: "approved_output",
      originLabelId: label.id,
      approvalId: approval.id,
      qualityWeight: 1.0,
      isApproved: true,
      fingerprint,

      // §12.1: scope defaults to company. "global" is a separate permission
      // (publish_global_reference) — the controller enforces that BEFORE this
      // function is ever called with scope:"global"; defaulting here would
      // reopen the exact cross-tenant leak G5 already condemned.
      companyId: scope === "global" ? null : label.companyId,
      brandId,
      country: label.country,

      fullText: renderPlainText(d),
      extractedData: d,
      activeIngredients: d.activeIngredients,
      targetSpecies: d.targetAnimalSpecies?.list || [],
      dosageForm: d.pharmaceuticalForm?.translations?.[d.pharmaceuticalForm.primary] || null,
      routeOfAdministration: d.routeOfAdministration?.translations?.[d.routeOfAdministration.primary] || null,
      strengthSummary: d.strength?.translations?.[d.strength.primary] || null,
      indicationTags: extractIndicationTags(d),
      productType: d.productType,
    },
  });

  return reference;
}

export { fingerprintFor, renderPlainText, extractIndicationTags };
