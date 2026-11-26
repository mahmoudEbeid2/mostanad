// PART 3 (28 Nov): "experiment mode" — the owner turns the certificate policy OFF for one company, or for
// all companies (those created later included), to see fully filled certificates and judge the output.
//   off-policy   every rule that keeps a field empty is skipped (lab results, batch facts, hard-never labels,
//                categories, registration numbers, readiness): the AI fills every empty field, marked
//                «مستنتج (تجربة)» (estimated: true, experiment: true)
//   rails        (always, not negotiable) every certificate made is a SAMPLE: is_experiment_sample, a large
//                diagonal "SAMPLE – NOT VALID" and "AI-generated test data" on every page of every output,
//                never approved / finalized / exported clean / revised into a valid one — turning the mode
//                off later does not unlock them; a real certificate is generated again with the policy on
//   who          the owner / super-admin only (the backend checks it); no env switch
//   audit        every toggle and every generation (who, when, company, which fields the AI filled)
// Read at generation time (global OR company), no restart.
import { prisma } from "../../../lib/prisma.js";
import { CertError } from "../errors.js";

export const GLOBAL_KEY = "experiment_mode_global";
export const ALL_COMPANIES_AR = "كل الشركات";

/** The owner / super-admin: a system user of the Admin ("Super Administrator") role — never a company session */
export const isSuperAdmin = (req) => !req.company && !!req.user && typeof req.user.role === "object" && /^admin$/i.test(String(req.user.role?.name || ""));

async function globalState() {
  const row = await prisma.appSetting.findUnique({ where: { key: GLOBAL_KEY } });
  return row?.value?.on ? { on: true, by: row.value.by || null, byName: row.value.byName || null, at: row.value.at || null } : { on: false };
}

/** Is the policy off for this company right now? (global OR its own switch) → { on, scope, byName } */
export async function experimentFor(companyId) {
  const g = await globalState();
  if (g.on) return { on: true, scope: "global", byName: g.byName, at: g.at };
  if (!companyId) return { on: false };
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { experimentMode: true, experimentModeBy: true, experimentModeAt: true } });
  return c?.experimentMode ? { on: true, scope: "company", by: c.experimentModeBy, at: c.experimentModeAt } : { on: false };
}

/** GET /experiment-mode?companyId= — what every screen shows (the banner) */
export async function experimentStatus(companyId = null) {
  const g = await globalState();
  let company = null;
  if (companyId) {
    const c = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, experimentMode: true, experimentModeBy: true, experimentModeAt: true } });
    if (c) {
      const by = c.experimentModeBy ? await prisma.user.findUnique({ where: { id: c.experimentModeBy }, select: { name: true } }) : null;
      company = { id: c.id, name: c.name, on: c.experimentMode, byName: by?.name || null, at: c.experimentModeAt };
    }
  }
  const companiesOn = await prisma.company.findMany({ where: { experimentMode: true }, select: { id: true, name: true } });
  return { global: g, company, companiesOn, banner: g.on || company?.on ? "وضع التجربة شغال — الشهادات دي عينات مش صالحة" : null };
}

export async function audit(action, { companyId = null, userId = null, details = null } = {}) {
  await prisma.experimentAudit.create({ data: { action, companyId, userId, details } }).catch((err) => console.error(`[experiment] audit ${action}: ${err.message}`));
}

/**
 * POST /experiment-mode { scope: company|global, companyId?, on, confirm? } — turning it ON needs the company's
 * name (or «كل الشركات») typed; OFF is one click. → the new status
 */
export async function setExperiment({ scope, companyId = null, on, confirm = "" }, user) {
  const fail = (msg, status = 400) => Object.assign(new Error(msg), { statusCode: status });
  if (!["company", "global"].includes(scope)) throw fail("scope is company or global");
  const at = new Date();
  if (scope === "global") {
    if (on && String(confirm).trim() !== ALL_COMPANIES_AR) throw fail(`اكتب «${ALL_COMPANIES_AR}» عشان تأكّد`);
    await prisma.appSetting.upsert({
      where: { key: GLOBAL_KEY },
      create: { key: GLOBAL_KEY, value: { on: !!on, by: user.id, byName: user.name || null, at: at.toISOString() }, updatedByUserId: user.id },
      update: { value: { on: !!on, by: user.id, byName: user.name || null, at: at.toISOString() }, updatedByUserId: user.id },
    });
    await audit(on ? "turned_on" : "turned_off", { userId: user.id, details: { scope: "global" } });
    return experimentStatus(companyId);
  }
  const c = companyId ? await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } }) : null;
  if (!c) throw fail("Company not found!", 404);
  if (on && String(confirm).trim().toLowerCase() !== c.name.trim().toLowerCase()) throw fail(`اكتب اسم الشركة «${c.name}» عشان تأكّد`);
  await prisma.company.update({ where: { id: c.id }, data: { experimentMode: !!on, experimentModeBy: user.id, experimentModeAt: at } });
  await audit(on ? "turned_on" : "turned_off", { companyId: c.id, userId: user.id, details: { scope: "company" } });
  return experimentStatus(c.id);
}

// ── the watermark (every page of every output: the HTML a PDF, a thumbnail, the combined PDF and the ZIP come from) ──
const WATERMARK_CSS = `<style data-experiment-watermark>
[data-page],.pf{overflow:hidden}
[data-page]::after,.pf::after{content:"SAMPLE \\2013  NOT VALID";position:absolute;left:-20%;top:42%;width:140%;text-align:center;transform:rotate(-35deg);font:900 64px/1 Arial,Helvetica,sans-serif;letter-spacing:4px;color:rgba(210,0,0,.30);pointer-events:none;z-index:2147483647;white-space:nowrap}
[data-page]::before,.pf::before{content:"AI-generated test data \\2014  experiment sample";position:absolute;left:0;right:0;bottom:4px;text-align:center;font:700 11px/1.2 Arial,Helvetica,sans-serif;color:rgba(210,0,0,.85);pointer-events:none;z-index:2147483647}
</style>`;

/** A certificate's HTML with the watermark on every page (idempotent) */
export function watermarkHtml(html) {
  const s = String(html || "");
  if (s.includes("data-experiment-watermark")) return s;
  return /<\/head>/i.test(s) ? s.replace(/<\/head>/i, `${WATERMARK_CSS}</head>`) : `${WATERMARK_CSS}${s}`;
}

/** Refused for a sample, at the service layer (approve, finalize, revise, clean export) */
export function assertNotSample(cert) {
  if (cert?.isExperimentSample) {
    throw new CertError("EXPERIMENT_SAMPLE", "دي عينة من وضع التجربة — مينفعش تتعتمد ولا تتصدّر كشهادة صالحة. طلّعها تاني والوضع مقفول.", 409);
  }
}
