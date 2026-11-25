import { Queue } from "bullmq";
import { getRedisConfig } from "../../../lib/redis.js";
import { prisma } from "../../../lib/prisma.js";

// Queueing a regulation document for reading (edaRequirementWorker) — the upload route and
// the assistant's add_regulatory_rules use the same call. review: stop before activation
// (a person sees and approves the rules); otherwise the automatic chain activates them.

let queue = null;
const edaQueue = () => (queue ||= new Queue("edaRequirementQueue", { connection: getRedisConfig() }));

/** → { taskId } */
export async function queueRegulatoryDocument({ buffer, fileName, mimeType, country, companyId = null, title = null, authority = null, productScope = [], sourceUrl = null, documentVersion = null, review = false }) {
  const task = await prisma.backgroundTask.create({ data: { type: "regulatory_document_extraction", status: "pending", companyId } });
  await edaQueue().add(
    "processEdaRequirement",
    { country, title, authority, productScope, sourceUrl, documentVersion, fileBufferBase64: buffer.toString("base64"), fileName, mimeType, companyId, review: !!review },
    { jobId: task.id }
  );
  return { taskId: task.id };
}

/** A document whose reading stopped: compile + audit in the background (it then awaits approval). → { taskId } */
export async function queueResume(documentId, companyId = null) {
  const task = await prisma.backgroundTask.create({ data: { type: "regulatory_document_extraction", status: "pending", companyId } });
  await edaQueue().add("resumeEdaRequirement", { resumeDocumentId: documentId, companyId }, { jobId: task.id });
  return { taskId: task.id };
}
