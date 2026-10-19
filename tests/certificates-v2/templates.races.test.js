// Review #9 — activation is compare-and-set inside its transaction. Two
// activations that both read "no active version" must not both win (two
// `active` versions, last writer owning the slot). Made deterministic: a third
// transaction holds the template row (FOR UPDATE) while both activations do
// their reads and block on the write; on release the second one re-checks its
// condition, finds the slot changed and gets 409 VERSION_CONFLICT.
//
// Review #15 — two writes into the same template slot: both pass the readable
// check, the partial unique index rejects the second (P2002) → it must be the
// same 409 TEMPLATE_SLOT_TAKEN, not a generic error. Made deterministic the
// same way: the competing row is inserted in an open transaction (invisible to
// the check), the update then waits on the index until that commits.
import { activateVersion } from "../../src/services/certificates/templates/prepareService.js";
import { updateTemplateSettings } from "../../src/services/certificates/templates/templateService.js";
import { putFile } from "../../src/services/certificates/storage/fileStore.js";
import { cleanupCompany, createCompany, finish, makeAssert, prisma } from "./helpers.js";

const { assert, counts } = makeAssert();
const company = await createCompany("tpl_races");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Holds a row lock on the template for `ms`, runs `then` inside the same transaction, commits. */
const holdTemplate = (templateId, ms, then = null) =>
  prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM certificate_templates WHERE id = ${templateId} FOR UPDATE`;
      await sleep(ms);
      if (then) await then(tx);
    },
    { timeout: ms + 10_000 }
  );

try {
  const type = await prisma.certificateType.create({ data: { companyId: company.id, name: "CAS test", code: `CAS${Date.now() % 100000}` } });
  const src = await putFile({ companyId: company.id, kind: "template_source", buffer: Buffer.from("<p>x</p>"), mimeType: "text/html", ext: "html" });
  const makeTemplate = async (name) => {
    const t = await prisma.certificateTemplate.create({ data: { companyId: company.id, certificateTypeId: type.id, name, country: name.slice(0, 2).toUpperCase() } });
    const [v1, v2] = await Promise.all(
      [1, 2].map((n) => prisma.templateVersion.create({ data: { templateId: t.id, versionNumber: n, status: "ready", sourceFormat: "html", sourceFileId: src.id } }))
    );
    return { t, v1, v2 };
  };

  console.log("\n🧪 Two activations racing on one template");
  const a = await makeTemplate("aa race");
  const lock = holdTemplate(a.t.id, 1500);
  await sleep(200); // the lock is held before either activation starts
  const results = await Promise.allSettled([activateVersion(a.v1.id, company.id), activateVersion(a.v2.id, company.id)]);
  await lock;
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert("exactly one wins, the other → 409 VERSION_CONFLICT", won.length === 1 && lost.length === 1 && lost[0].reason?.code === "VERSION_CONFLICT" && lost[0].reason?.statusCode === 409, results.map((r) => r.reason?.code || r.status));
  const tpl = await prisma.certificateTemplate.findUnique({ where: { id: a.t.id } });
  const statuses = Object.fromEntries((await prisma.templateVersion.findMany({ where: { templateId: a.t.id } })).map((v) => [v.id, v.status]));
  const winner = won[0]?.value?.versionId;
  assert("the slot points at the winner; it is the only active version, the loser is still ready", tpl.activeVersionId === winner && Object.values(statuses).filter((s) => s === "active").length === 1 && statuses[winner] === "active" && statuses[winner === a.v1.id ? a.v2.id : a.v1.id] === "ready", { tpl: tpl.activeVersionId, statuses });

  console.log("\n🧪 Sequential activation still supersedes");
  const loser = winner === a.v1.id ? a.v2.id : a.v1.id;
  const r = await activateVersion(loser, company.id);
  const after = Object.fromEntries((await prisma.templateVersion.findMany({ where: { templateId: a.t.id } })).map((v) => [v.id, v.status]));
  assert("activating the other one afterwards → active, previous superseded", r.supersededVersionId === winner && after[loser] === "active" && after[winner] === "superseded", after);

  console.log("\n🧪 Archived between the check and the write");
  const b = await makeTemplate("bb archive");
  // the lock holder archives the template and commits while the activation —
  // which already passed its archivedAt check — waits on the slot write
  const lock2 = holdTemplate(b.t.id, 1200, (tx) => tx.certificateTemplate.update({ where: { id: b.t.id }, data: { archivedAt: new Date() } }));
  await sleep(200);
  const out = await activateVersion(b.v1.id, company.id).then(
    (x) => ({ ok: x }),
    (e) => ({ err: e })
  );
  await lock2;
  const bt = await prisma.certificateTemplate.findUnique({ where: { id: b.t.id } });
  const bv = await prisma.templateVersion.findUnique({ where: { id: b.v1.id } });
  assert("archived meanwhile → 409 VERSION_CONFLICT; nothing activated on the archived template", out.err?.code === "VERSION_CONFLICT" && bt.activeVersionId === null && bv.status === "ready", { out: out.err?.code || "ok", active: bt.activeVersionId, status: bv.status });

  console.log("\n🧪 Slot race: the unique index's P2002 → 409 TEMPLATE_SLOT_TAKEN (review #15)");
  const mover = await prisma.certificateTemplate.create({ data: { companyId: company.id, certificateTypeId: type.id, name: "mover", country: "MV" } });
  let rivalId = null;
  const rival = prisma.$transaction(
    async (tx) => {
      const t = await tx.certificateTemplate.create({ data: { companyId: company.id, certificateTypeId: type.id, name: "rival", country: "ZZ" } });
      rivalId = t.id;
      await sleep(1200); // uncommitted: the mover's check can't see it, its write waits on the index
    },
    { timeout: 15_000 }
  );
  await sleep(200);
  const moved = await updateTemplateSettings(mover.id, company.id, { country: "ZZ" }).then(
    (x) => ({ ok: x }),
    (e) => ({ err: e })
  );
  await rival;
  assert(
    "moving into a slot taken meanwhile → 409 TEMPLATE_SLOT_TAKEN naming the winner",
    moved.err?.code === "TEMPLATE_SLOT_TAKEN" && moved.err?.statusCode === 409 && moved.err?.extra?.existingTemplateId === rivalId,
    { code: moved.err?.code, status: moved.err?.statusCode, extra: moved.err?.extra, message: moved.err?.message }
  );
  assert("the mover kept its slot", (await prisma.certificateTemplate.findUnique({ where: { id: mover.id } })).country === "MV");
} finally {
  await finish(counts, () => cleanupCompany(company.id));
}
