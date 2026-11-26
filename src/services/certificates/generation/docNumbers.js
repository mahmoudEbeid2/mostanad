import { prisma } from "../../../lib/prisma.js";

// A certificate's own document number (28 Nov): the company's numbering, learnt from its documents
// (harvest: "COAAVVI0926001" → COAAVVI{MM}{YY}{SEQ3}), continued — the sample's number is never
// printed, and two certificates never get the same one (one atomic UPDATE per number).
// No pattern known for the type → "{CODE}-{YYYY}-{SEQ4}".

const pad = (n, w) => String(n).padStart(w, "0");

export function formatNumber(pattern, seq, at = new Date()) {
  const yy = String(at.getFullYear()).slice(-2);
  const mm = pad(at.getMonth() + 1, 2);
  return pattern
    .replace("{YYYY}", String(at.getFullYear()))
    .replace("{YY}", yy)
    .replace("{MM}", mm)
    .replace(/\{SEQ(\d+)\}/, (_m, w) => pad(seq, Number(w)));
}

/** The next number for a company's certificate type → "COAAVVI1126002" */
export async function allocateDocNumber(companyId, certCode, at = new Date()) {
  const code = String(certCode || "DOC").toUpperCase().replace(/[^A-Z0-9]/g, "") || "DOC";
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { profile: true } });
  const known = company?.profile?.numbering?.[code];
  const pattern = known?.pattern || `${code}-{YYYY}-{SEQ4}`;
  // one statement: read-and-increment the counter inside the company's profile
  const rows = await prisma.$queryRaw`
    UPDATE companies
    SET profile = jsonb_set(
      jsonb_set(COALESCE(profile, '{}'::jsonb), '{numbering}', COALESCE(profile->'numbering', '{}'::jsonb), true),
      ARRAY['numbering', ${code}],
      COALESCE(profile->'numbering'->${code}, '{}'::jsonb) || jsonb_build_object('pattern', ${pattern}::text, 'lastSeq', COALESCE((profile->'numbering'->${code}->>'lastSeq')::int, 0) + 1),
      true)
    WHERE id = ${companyId}
    RETURNING (profile->'numbering'->${code}->>'lastSeq')::int AS seq`;
  const seq = rows[0]?.seq ?? 1;
  return formatNumber(pattern, seq, at);
}
