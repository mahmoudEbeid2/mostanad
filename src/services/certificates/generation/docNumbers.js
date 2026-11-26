import { prisma } from "../../../lib/prisma.js";

// A certificate's own document number (Phase 3, 28 Nov): the company's numbering for that certificate type,
// continued — the sample's number is never printed, and no number is ever given twice:
//   numbering_schemes  one per company + type: the pattern ("COAAVVI{MM}{YY}{SEQ3}"), its counter, and whether
//                      a person confirmed it. Learnt from the company's documents (harvest: "detected"), set by
//                      a person ("user"), else the default "{CODE}-{YYYY}-{SEQ4}" (asked once, in Arabic)
//   document_numbers   every number given out, unique per company: a clash (a number a person typed, two
//                      schemes giving the same text) takes the next one
// The counter moves in one UPDATE … RETURNING, so two certificates never get the same sequence.

const pad = (n, w) => String(n).padStart(w, "0");
export const codeOf = (certCode) => String(certCode || "DOC").toUpperCase().replace(/[^A-Z0-9]/g, "") || "DOC";
export const defaultPattern = (code) => `${code}-{YYYY}-{SEQ4}`;
export const validPattern = (p) => typeof p === "string" && p.length <= 60 && /\{SEQ\d\}/.test(p) && !/[{}]/.test(p.replace(/\{(YYYY|YY|MM|SEQ\d)\}/g, ""));

export function formatNumber(pattern, seq, at = new Date()) {
  const yy = String(at.getFullYear()).slice(-2);
  const mm = pad(at.getMonth() + 1, 2);
  return pattern
    .replace("{YYYY}", String(at.getFullYear()))
    .replace("{YY}", yy)
    .replace("{MM}", mm)
    .replace(/\{SEQ(\d+)\}/, (_m, w) => pad(seq, Number(w)));
}

/**
 * The scheme of a company + type, made when missing: from what the company's documents taught
 * (company.profile.numbering, harvest) or the default. → the row
 */
export async function schemeFor(companyId, certCode) {
  const code = codeOf(certCode);
  const found = await prisma.numberingScheme.findUnique({ where: { companyId_certCode: { companyId, certCode: code } } });
  if (found) return found;
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { profile: true } });
  const learnt = company?.profile?.numbering?.[code];
  const data = learnt?.pattern
    ? { companyId, certCode: code, pattern: learnt.pattern, lastSeq: Number(learnt.lastSeq) || 0, source: "detected", example: learnt.example || learnt.file || null }
    : { companyId, certCode: code, pattern: defaultPattern(code), lastSeq: 0, source: "default" };
  return prisma.numberingScheme.upsert({ where: { companyId_certCode: { companyId, certCode: code } }, create: data, update: {} });
}

/** What the documents taught (harvest) → the scheme, unless a person set it; the counter only moves forward */
export async function learnScheme(companyId, certCode, { pattern, seq = 0, example = null }) {
  const code = codeOf(certCode);
  const cur = await prisma.numberingScheme.findUnique({ where: { companyId_certCode: { companyId, certCode: code } } });
  if (cur?.source === "user") return cur;
  if (!cur) return prisma.numberingScheme.create({ data: { companyId, certCode: code, pattern, lastSeq: seq, source: "detected", example } });
  return prisma.numberingScheme.update({ where: { id: cur.id }, data: { pattern, lastSeq: cur.pattern === pattern ? Math.max(cur.lastSeq, seq) : seq, source: "detected", example: example || cur.example } });
}

/** The next number for a company's certificate type → "COAAVVI1126002" (claimed: never given again) */
export async function allocateDocNumber(companyId, certCode, at = new Date(), certificateId = null) {
  const code = codeOf(certCode);
  await schemeFor(companyId, code);
  for (let tries = 0; tries < 50; tries++) {
    const rows = await prisma.$queryRaw`
      UPDATE numbering_schemes SET last_seq = last_seq + 1, updated_at = NOW()
      WHERE company_id = ${companyId} AND cert_code = ${code}
      RETURNING last_seq AS seq, pattern`;
    const { seq, pattern } = rows[0];
    const number = formatNumber(pattern, Number(seq), at);
    const claimed = await prisma.$executeRaw`
      INSERT INTO document_numbers (id, company_id, cert_code, number, certificate_id)
      VALUES (gen_random_uuid()::text, ${companyId}, ${code}, ${number}, ${certificateId})
      ON CONFLICT (company_id, number) DO NOTHING`;
    if (claimed) return number;
  }
  throw new Error(`No free ${code} number after 50 tries — check the company's ${code} numbering`);
}

/** A person sets a scheme (or confirms the learnt one) → the row */
export async function setScheme(companyId, certCode, { pattern, lastSeq = null }, userId = null) {
  const code = codeOf(certCode);
  if (!validPattern(pattern)) throw Object.assign(new Error("The pattern needs {SEQ3} (or another width) and only {YYYY}, {YY}, {MM} as placeholders"), { statusCode: 400 });
  const cur = await schemeFor(companyId, code);
  return prisma.numberingScheme.update({ where: { id: cur.id }, data: { pattern, ...(Number.isInteger(lastSeq) && lastSeq >= 0 ? { lastSeq } : {}), confirmed: true, source: "user", updatedByUserId: userId } });
}

/** A company's schemes, each with its next number (nothing claimed) */
export async function listSchemes(companyId, at = new Date()) {
  const rows = await prisma.numberingScheme.findMany({ where: { companyId }, orderBy: { certCode: "asc" } });
  return rows.map((s) => ({ certCode: s.certCode, pattern: s.pattern, lastSeq: s.lastSeq, confirmed: s.confirmed, source: s.source, example: s.example, next: formatNumber(s.pattern, s.lastSeq + 1, at) }));
}

/** "ask once": the schemes of these types nobody confirmed yet, in Arabic → string | null */
export async function numberingQuestionAr(companyId, certCodes) {
  const lines = [];
  for (const code of [...new Set(certCodes.map(codeOf))]) {
    const s = await schemeFor(companyId, code);
    if (s.confirmed) continue;
    const next = formatNumber(s.pattern, s.lastSeq + 1);
    lines.push(s.source === "detected" ? `• ${code}: كمّلنا ترقيمك (${s.pattern}) — اللي جاي ${next}${s.example ? `، من ${s.example}` : ""}` : `• ${code}: ملقيناش ترقيم ليك فاستخدمنا ${s.pattern} — اللي جاي ${next}`);
  }
  return lines.length ? ["أرقام الشهادات — لو الترقيم مش ده، غيّره من صفحة الشركة (مرة واحدة بس):", ...lines].join("\n") : null;
}
