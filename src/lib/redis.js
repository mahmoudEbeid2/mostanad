import { URL } from "url";

/**
 * Get configured Redis connection options for BullMQ and general usage.
 * BullMQ requires maxRetriesPerRequest to be null.
 */
export const getRedisConfig = () => {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

  try {
    const parsed = new URL(redisUrl);
    return {
      host: parsed.hostname || "localhost",
      port: parseInt(parsed.port || "6379", 10),
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      maxRetriesPerRequest: null, // Required by BullMQ
    };
  } catch (error) {
    console.warn(`[RedisConfig] Failed to parse REDIS_URL "${redisUrl}", using defaults.`, error.message);
    return {
      host: "localhost",
      port: 6379,
      maxRetriesPerRequest: null,
    };
  }
};
