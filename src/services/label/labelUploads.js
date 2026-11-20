import { Queue } from "bullmq";
import { getRedisConfig } from "../../lib/redis.js";
import { prisma } from "../../lib/prisma.js";
import { saveTempFile } from "../../utils/fileHelper.js";
import { addLabelJob } from "../../lib/queue.js";

// The two label uploads, moved out of their controllers (unchanged behaviour)
// so the routes and the assistant's confirmed actions start the same jobs.

let referenceLabelQueue = null;
const referenceQueue = () => (referenceLabelQueue ||= new Queue("referenceLabelQueue", { connection: getRedisConfig() }));

/**
 * POST /products/verify-label: a label file checked against a country's rules,
 * in the background. → { taskId }
 */
export async function startLabelVerification({ buffer, originalName, mimeType, country, companyId = null }) {
  const filePath = saveTempFile(buffer, originalName);
  const task = await prisma.backgroundTask.create({ data: { type: "label_verification", status: "pending", companyId } });
  await addLabelJob(task.id, { filePath, fileName: originalName, mimeType, country, companyId });
  return { taskId: task.id };
}

/**
 * POST /reference-labels: one approved label file read into a reference label,
 * in the background. A file whose name is already a reference is skipped.
 * → { taskId } | { skipped: true }
 */
export async function queueReferenceLabel({ buffer, originalName, mimeType, country, companyId = null, brandId = null, categoryId = null, manualCategoryName = null }) {
  const existing = await prisma.referenceLabel.findFirst({ where: { name: originalName } });
  if (existing) {
    console.log(`[ReferenceLabels] Skipping ${originalName}, already exists.`);
    return { skipped: true };
  }
  const task = await prisma.backgroundTask.create({ data: { type: "reference_label_extraction", status: "pending", companyId, brandId } });
  await referenceQueue().add(
    "processReferenceLabel",
    {
      fileName: originalName,
      mimeType,
      fileBufferBase64: buffer.toString("base64"),
      taskId: task.id,
      companyId,
      brandId,
      country: country.trim(),
      categoryId,
      manualCategoryName: manualCategoryName?.trim() || null,
    },
    { jobId: task.id, removeOnComplete: true, removeOnFail: 100, attempts: 4, backoff: { type: "exponential", delay: 15000 } }
  );
  return { taskId: task.id };
}
