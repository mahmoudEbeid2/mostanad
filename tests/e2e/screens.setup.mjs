// Phase 7 screenshots — local set-up only: a screenshot user (system admin role, random password kept
// in reports/addvet-e2e/screens/.login.json, gitignored with reports/), the live run's ADDVET chat and
// drop handed to it (the test login is a synthetic user no browser can be), and one certificate request
// for ADDVET's products so the matrix and the designer's panel have something to show.
//   node tests/e2e/screens.setup.mjs
import fs from "fs";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../../src/lib/prisma.js";
import { createRequest, generateRequest } from "../../src/services/certificates/workflow/requestService.js";

const OUT = path.join(process.cwd(), "reports", "addvet-e2e", "screens");
fs.mkdirSync(OUT, { recursive: true });
const admin = await prisma.user.findFirst({ where: { username: process.env.ADMIN_USERNAME || "admin" }, select: { roleId: true } });
if (!admin?.roleId) throw new Error("no admin role to copy");
const password = crypto.randomBytes(12).toString("base64url");
const user = await prisma.user.upsert({
  where: { username: "screens" },
  update: { password: await bcrypt.hash(password, 10), roleId: admin.roleId, isActive: true },
  create: { name: "Screenshots (local)", username: "screens", email: "screens@local.test", password: await bcrypt.hash(password, 10), roleId: admin.roleId },
});
fs.writeFileSync(path.join(OUT, ".login.json"), JSON.stringify({ username: "screens", password }), { mode: 0o600 });

const co = await prisma.company.findFirst({ where: { name: { equals: "ADDVET", mode: "insensitive" } }, select: { id: true } });
if (!co) throw new Error("run tests/e2e/addvetExpress.e2e.mjs --live first");
// the live run's drop (created in "All companies", so found by the id its summary kept)
const live = JSON.parse(fs.readFileSync(path.join(process.cwd(), "reports", "addvet-e2e", "live", "summary.json"), "utf8"));
const batch = await prisma.intakeBatch.findUnique({ where: { id: live.batchId } });
if (!batch) throw new Error("the live run's drop is gone — run the live e2e again");
const from = { ownerType: batch.ownerType, ownerId: batch.ownerId };
await prisma.intakeBatch.updateMany({ where: { id: batch.id }, data: { ownerType: "user", ownerId: user.id } });
if (batch.conversationId) {
  await prisma.assistantConversation.updateMany({ where: { id: batch.conversationId }, data: { ownerType: "user", ownerId: user.id } });
  await prisma.assistantAction.updateMany({ where: { conversationId: batch.conversationId }, data: { ownerType: "user", ownerId: user.id } });
  await prisma.assistantAttachment.updateMany({ where: { conversationId: batch.conversationId }, data: { ownerType: "user", ownerId: user.id } }).catch(() => {});
}
// a request from pasted names (no invoice): two of ADDVET's products
const req = await createRequest({ companyId: co.id, userId: user.id, text: "ADDMECTIN 1%\nOLIGOVET", certificateCodes: ["COA", "COC", "HC", "FSC"] });
const gen = await generateRequest(req.request.id, co.id, user.id).catch((e) => ({ error: e.message }));
const cert = await prisma.certificate.findFirst({ where: { companyId: co.id, flagCount: { gt: 0 } }, orderBy: { createdAt: "asc" }, select: { id: true } });
const template = await prisma.certificateTemplate.findFirst({ where: { companyId: co.id, certificateType: { code: "COA" } }, select: { id: true, activeVersionId: true } });
const hc = await prisma.certificateTemplate.findFirst({ where: { companyId: co.id, certificateType: { code: "HC" } }, include: { versions: { orderBy: { versionNumber: "desc" }, take: 1, select: { id: true } } } });
const product = await prisma.product.findFirst({ where: { companyId: co.id, name: "OLIGOVET" }, select: { id: true } });
const ids = { userId: user.id, handedFrom: from, companyId: co.id, conversationId: batch.conversationId, batchId: batch.id, requestId: req.request.id, generate: gen.error || gen.taskId, certificateId: cert?.id, coaTemplate: template, hcTemplate: hc && { id: hc.id, versionId: hc.versions[0]?.id }, productId: product?.id };
fs.writeFileSync(path.join(OUT, "ids.json"), JSON.stringify(ids, null, 1));
console.log(JSON.stringify(ids, null, 1));
await prisma.$disconnect();
