import { prisma } from "../../../lib/prisma.js";

// A certificate's own document number (Phase 3, 28 Nov): the company's numbering for that certificate type,
// continued — the sample's number is never printed, and no number is ever given twice:
//   numbering_schemes  one per company + type: the pattern ("COAAVVI{MM}{YY}{SEQ3}"), its counter, and whether
//                      a person confirmed it. Learnt from the company's documents (harvest: "detected"), set by
//                      a person ("user"), else the default "{CODE}-{YYYY}-{SEQ4}" (asked once, in Arabic)
//   document_numbers   every number given out, unique per company: a clash (a number a person typed, two
//                      schemes giving the same text) takes the next one
// The counter moves in one UPDATE … RETURNING, so two certificates never get the same sequence.
// It never goes back (29 Nov): whoever sets it — the documents, a person, a switch of pattern — it starts
// after the highest number this company already issued in that pattern.
// Monthly (27 Nov, owner): a type's sequence may restart every month — "COCAF{YY}0{MM}{SEQ3}" printed 010 in
// October as October's 10th. Per company + type (reset_monthly, on by default), and only for a pattern that
// prints the month AND the year (else a restart would print a number twice). seq_period is the month the
// counter counts in; the first number of a new month is 1.

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

/** "2026-11" */
export const periodOf = (at = new Date()) => `${at.getFullYear()}-${pad(at.getMonth() + 1, 2)}`;
/** Does this pattern restart every month? (the setting, and a pattern printing the month and the year) */
export const monthlyPattern = (pattern) => /\{MM\}/.test(pattern) && /\{YY(?:YY)?\}/.test(pattern);
export const resetsMonthly = (scheme) => scheme.resetMonthly !== false && monthlyPattern(scheme.pattern);

/** "COAAVVI{MM}{YY}{SEQ3}" → a regex catching the sequence of a number written in it (only month `at`'s, when given) */
export function patternRegex(pattern, at = null) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let src = "";
  for (const part of String(pattern).split(/(\{(?:YYYY|YY|MM|SEQ\d+)\})/)) {
    if (part === "{YYYY}") src += at ? String(at.getFullYear()) : String.raw`\d{4}`;
    else if (part === "{YY}") src += at ? String(at.getFullYear()).slice(-2) : String.raw`\d{2}`;
    else if (part === "{MM}") src += at ? pad(at.getMonth() + 1, 2) : String.raw`\d{2}`;
    else if (/^\{SEQ(\d+)\}$/.test(part)) src += String.raw`(\d{` + part.match(/\d+/)[0] + ",})";
    else src += esc(part);
  }
  return new RegExp(`^${src}$`);
}

/** The highest sequence this company already issued for a type in a pattern (0 when none) — in month `at` only, when given */
export async function issuedMax(companyId, code, pattern, at = null) {
  const re = patternRegex(pattern, at);
  const rows = await prisma.documentNumber.findMany({ where: { companyId, certCode: code }, select: { number: true } });
  return rows.reduce((max, r) => {
    const m = re.exec(r.number);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
}

/**
 * The scheme of a company + type, made when missing: from what the company's documents taught
 * (company.profile.numbering, harvest) or the default. → the row
 */
export async function schemeFor(companyId, certCode) {
  const code = codeOf(certCode);
  const found = await prisma.numberingScheme.findUnique({ where: { companyId_certCode: { companyId, certCode: code } } });
  const company = found && found.source !== "default" ? null : await prisma.company.findUnique({ where: { id: companyId }, select: { profile: true } });
  const learnt = company?.profile?.numbering?.[code];
  // a default nobody confirmed yields to what the documents taught since (its own numbers stay given)
  if (found && found.source === "default" && !found.confirmed && learnt?.pattern && validPattern(learnt.pattern)) {
    return learnScheme(companyId, code, { pattern: learnt.pattern, seq: Number(learnt.lastSeq) || 0, example: learnt.example || learnt.file || null });
  }
  if (found) return found;
  const data = learnt?.pattern
    ? monthlyPattern(learnt.pattern)
      ? { companyId, certCode: code, pattern: learnt.pattern, lastSeq: 0, seqPeriod: periodOf(), source: "detected", example: learnt.example || learnt.file || null } // a document's number is its own month's
      : { companyId, certCode: code, pattern: learnt.pattern, lastSeq: Number(learnt.lastSeq) || 0, source: "detected", example: learnt.example || learnt.file || null }
    : { companyId, certCode: code, pattern: defaultPattern(code), lastSeq: 0, source: "default" };
  return prisma.numberingScheme.upsert({ where: { companyId_certCode: { companyId, certCode: code } }, create: data, update: {} });
}

/** What the documents taught (harvest) → the scheme, unless a person set it; the counter only moves forward */
export async function learnScheme(companyId, certCode, { pattern, seq = 0, example = null }) {
  const code = codeOf(certCode);
  const cur = await prisma.numberingScheme.findUnique({ where: { companyId_certCode: { companyId, certCode: code } } });
  if (cur?.source === "user") return cur;
  // a monthly sequence: the document's number is its own month's — this month counts from what was issued
  // in it (an October "010" never makes November start at 011)
  const at = new Date();
  if ((cur?.resetMonthly ?? true) && monthlyPattern(pattern)) {
    const issued = await issuedMax(companyId, code, pattern, at);
    const keep = cur && cur.pattern === pattern && cur.seqPeriod === periodOf(at) ? cur.lastSeq : 0;
    const data = { pattern, lastSeq: Math.max(keep, issued), seqPeriod: periodOf(at), source: "detected", example: example || cur?.example || null };
    return cur ? prisma.numberingScheme.update({ where: { id: cur.id }, data }) : prisma.numberingScheme.create({ data: { companyId, certCode: code, ...data } });
  }
  // never back: past the documents' last number AND every number already issued in this pattern
  const floor = Math.max(Number(seq) || 0, await issuedMax(companyId, code, pattern));
  if (!cur) return prisma.numberingScheme.create({ data: { companyId, certCode: code, pattern, lastSeq: floor, source: "detected", example } });
  return prisma.numberingScheme.update({ where: { id: cur.id }, data: { pattern, lastSeq: cur.pattern === pattern ? Math.max(cur.lastSeq, floor) : floor, source: "detected", example: example || cur.example } });
}

/** The next number for a company's certificate type → "COAAVVI1126002" (claimed: never given again) */
export async function allocateDocNumber(companyId, certCode, at = new Date(), certificateId = null) {
  const code = codeOf(certCode);
  await schemeFor(companyId, code);
  for (let tries = 0; tries < 50; tries++) {
    // a new month restarts a monthly sequence (a counter with no month yet goes on: it was set this month)
    const period = periodOf(at);
    const rows = await prisma.$queryRaw`
      UPDATE numbering_schemes SET
        last_seq = CASE WHEN reset_monthly AND pattern LIKE '%{MM}%' AND pattern LIKE '%{YY%' AND seq_period IS NOT NULL AND seq_period <> ${period} THEN 1 ELSE last_seq + 1 END,
        seq_period = ${period}, updated_at = NOW()
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

/**
 * A person sets a scheme (or confirms the learnt one) → the row.
 * nextNumber: the sequence the next certificate gets (this month's, for a monthly one); resetMonthly: the switch.
 */
export async function setScheme(companyId, certCode, { pattern, lastSeq = null, nextNumber = null, resetMonthly = null }, userId = null, at = new Date()) {
  const code = codeOf(certCode);
  if (!validPattern(pattern)) throw Object.assign(new Error("The pattern needs {SEQ3} (or another width) and only {YYYY}, {YY}, {MM} as placeholders"), { statusCode: 400 });
  const cur = await schemeFor(companyId, code);
  const monthly = (typeof resetMonthly === "boolean" ? resetMonthly : cur.resetMonthly !== false) && monthlyPattern(pattern);
  // a person's counter never goes below a number already given in that pattern (no number twice) — this
  // month's numbers only, for a monthly sequence
  const issued = await issuedMax(companyId, code, pattern, monthly ? at : null);
  const asked = Number.isInteger(nextNumber) && nextNumber >= 1 ? nextNumber - 1 : Number.isInteger(lastSeq) && lastSeq >= 0 ? lastSeq : null;
  const sameMonth = !monthly || !cur.seqPeriod || cur.seqPeriod === periodOf(at);
  const wanted = asked ?? (cur.pattern === pattern && sameMonth ? cur.lastSeq : 0);
  return prisma.numberingScheme.update({
    where: { id: cur.id },
    data: { pattern, lastSeq: Math.max(wanted, issued), seqPeriod: periodOf(at), ...(typeof resetMonthly === "boolean" ? { resetMonthly } : {}), confirmed: true, source: "user", updatedByUserId: userId },
  });
}

/** The sequence the next certificate of a scheme gets (a monthly one restarts in a new month) */
export const nextSeq = (s, at = new Date()) => (resetsMonthly(s) && s.seqPeriod && s.seqPeriod !== periodOf(at) ? 1 : s.lastSeq + 1);

/** A company's schemes, each with its next number (nothing claimed) */
export async function listSchemes(companyId, at = new Date()) {
  const rows = await prisma.numberingScheme.findMany({ where: { companyId }, orderBy: { certCode: "asc" } });
  return rows.map((s) => ({ certCode: s.certCode, pattern: s.pattern, lastSeq: s.lastSeq, nextNumber: nextSeq(s, at), resetMonthly: s.resetMonthly !== false, monthly: resetsMonthly(s), monthlyPossible: monthlyPattern(s.pattern), seqPeriod: s.seqPeriod, confirmed: s.confirmed, source: s.source, example: s.example, next: formatNumber(s.pattern, nextSeq(s, at), at) }));
}

/** "ask once": the schemes of these types nobody confirmed yet, in Arabic → string | null */
export async function numberingQuestionAr(companyId, certCodes) {
  const lines = [];
  for (const code of [...new Set(certCodes.map(codeOf))]) {
    const s = await schemeFor(companyId, code);
    if (s.confirmed) continue;
    const next = formatNumber(s.pattern, nextSeq(s));
    lines.push(s.source === "detected" ? `• ${code}: كمّلنا ترقيمك (${s.pattern}) — اللي جاي ${next}${s.example ? `، من ${s.example}` : ""}` : `• ${code}: ملقيناش ترقيم ليك فاستخدمنا ${s.pattern} — اللي جاي ${next}`);
  }
  return lines.length ? ["أرقام الشهادات — لو الترقيم مش ده، غيّره من صفحة الشركة (مرة واحدة بس):", ...lines].join("\n") : null;
}
