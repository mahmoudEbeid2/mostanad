import { Queue } from "bullmq";
import { getRedisConfig } from "./redis.js";

const connection = getRedisConfig();

// Initialize queues with connection options
export const catalogQueue = new Queue("catalogQueue", { connection });
export const labelQueue = new Queue("labelQueue", { connection });
export const certificateQueue = new Queue("certificateQueue", { connection });
export const emailQueue = new Queue("emailQueue", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 5000, // Wait 5 seconds, then double on subsequent attempts
    },
  },
});

/**
 * Add a catalog ingestion job
 */
export const addCatalogJob = async (jobId, data) => {
  return catalogQueue.add("processCatalog", data, { jobId });
};

/**
 * Add a label verification job
 */
export const addLabelJob = async (jobId, data) => {
  return labelQueue.add("processLabel", data, { jobId });
};

/**
 * Add a certificate generation job
 */
export const addCertificateJob = async (jobId, data) => {
  return certificateQueue.add("processCertificate", data, { jobId });
};

/**
 * Add an email sending job
 */
export const addEmailJob = async (data) => {
  return emailQueue.add("sendEmail", data);
};
