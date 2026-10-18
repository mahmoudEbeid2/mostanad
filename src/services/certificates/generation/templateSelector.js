// Template selection (CERTIFICATES_V2_PLAN.md §10.1, §20 I15/I16) — a pure
// function, no I/O. For every (certificate type, scope) that has active
// templates, each matched invoice line gets the MOST SPECIFIC applicable one:
//   brand-specific (= the product's brand, else the invoice's brand hint) beats brandless;
//   country-specific (= the invoice's country) beats countryless;
//   a template with a country is never used for another country, nor a branded
//   one for another brand.
// The slot-uniqueness rule makes ties impossible within one (type, scope).
//
// input:
//   invoice:   { country, brandId }
//   items:     [{ id, lineNo, matchStatus, productId, data: { name, batchNo, … }, product: { id, name, brandId, brand?: { name } } }]
//   templates: active templates [{ id, name, certificateTypeId, certificateType: { code, name }, brandId, brand?: { name }, country, scope,
//                                  activeVersionId, activeVersion?: { versionNumber } }]
// output (frozen into CertificateBatch.plan):
//   { entries: [{ planKey, certificateTypeId, typeCode, typeName, templateId, templateName, templateVersionId, versionNumber,
//                 scope, productId, invoiceItemIds[], lineNos[] }],
//     unassigned: [{ invoiceItemId, lineNo, name }],            // lines that get no certificate at all
//     gaps: [{ invoiceItemId, lineNo, name, certificateTypeId, typeCode, typeName, scope, brandId, brandName, country }],
//                                                                // a type the company issues, but no template fits this line
//     summary: [{ certificateTypeId, typeCode, typeName, scope, templateId, templateName, templateVersionId, versionNumber, count, lines }] }

const specificity = (t) => (t.brandId ? 2 : 0) + (t.country ? 1 : 0);

export const lineBrandId = (item, invoice) => item.product?.brandId || invoice.brandId || null;

export function applicable(template, { brandId, country }) {
  if (!template.activeVersionId) return false;
  if (template.brandId && template.brandId !== brandId) return false;
  if (template.country && template.country !== (country || null)) return false;
  return true;
}

/** The most specific applicable template of one (type, scope) group, or null. */
export function pickTemplate(group, ctx) {
  let best = null;
  for (const t of group) {
    if (!applicable(t, ctx)) continue;
    if (!best || specificity(t) > specificity(best)) best = t;
  }
  return best;
}

export function selectTemplates({ invoice, items, templates }) {
  const lines = items.filter((i) => i.matchStatus === "matched" && i.productId).sort((a, b) => a.lineNo - b.lineNo);
  const groups = new Map(); // "typeId|scope" → templates
  for (const t of templates) {
    if (!t.activeVersionId) continue;
    const k = `${t.certificateTypeId}|${t.scope}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }

  const entries = [];
  const gaps = [];
  const covered = new Set();
  const perInvoice = new Map(); // templateVersionId → entry

  for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const sample = group[0];
    for (const item of lines) {
      const ctx = { brandId: lineBrandId(item, invoice), country: invoice.country || null };
      const t = pickTemplate(group, ctx);
      if (!t) {
        gaps.push({
          invoiceItemId: item.id,
          lineNo: item.lineNo,
          name: item.product?.name || item.data?.name || null,
          certificateTypeId: sample.certificateTypeId,
          typeCode: sample.certificateType?.code || null,
          typeName: sample.certificateType?.name || null,
          scope: sample.scope,
          brandId: ctx.brandId,
          brandName: item.product?.brand?.name || null,
          country: ctx.country,
        });
        continue;
      }
      covered.add(item.id);
      const base = {
        certificateTypeId: t.certificateTypeId,
        typeCode: t.certificateType?.code || null,
        typeName: t.certificateType?.name || null,
        templateId: t.id,
        templateName: t.name,
        templateVersionId: t.activeVersionId,
        versionNumber: t.activeVersion?.versionNumber ?? null,
        scope: t.scope,
      };
      if (t.scope === "per_invoice") {
        // assumption A2: one collective certificate per resolved template version
        let e = perInvoice.get(t.activeVersionId);
        if (!e) {
          e = { ...base, planKey: `${t.activeVersionId}:invoice`, productId: null, invoiceItemIds: [], lineNos: [] };
          perInvoice.set(t.activeVersionId, e);
          entries.push(e);
        }
        e.invoiceItemIds.push(item.id);
        e.lineNos.push(item.lineNo);
      } else {
        entries.push({ ...base, planKey: `${t.activeVersionId}:${item.id}`, productId: item.productId, invoiceItemIds: [item.id], lineNos: [item.lineNo] });
      }
    }
  }

  const unassigned = lines.filter((i) => !covered.has(i.id)).map((i) => ({ invoiceItemId: i.id, lineNo: i.lineNo, name: i.product?.name || i.data?.name || null }));

  const summary = [];
  for (const e of entries) {
    let s = summary.find((x) => x.templateVersionId === e.templateVersionId);
    if (!s) {
      s = { certificateTypeId: e.certificateTypeId, typeCode: e.typeCode, typeName: e.typeName, scope: e.scope, templateId: e.templateId, templateName: e.templateName, templateVersionId: e.templateVersionId, versionNumber: e.versionNumber, count: 0, lines: 0 };
      summary.push(s);
    }
    s.count++;
    s.lines += e.invoiceItemIds.length;
  }

  return { entries, unassigned, gaps, summary };
}
