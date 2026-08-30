import { Redis } from "ioredis";

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  acquireLock(key: string, ttlSeconds?: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Redis-backed cache, see architecture.md §42 & §45.
 * Holds ephemeral data only — never core source-of-truth data.
 * Lazy connection: the API must start even when Redis is down, and cache
 * failures surface per-request instead of blocking boot.
 */
export function createCache(redisUrl: string, db = 2): Cache {
  const redis = new Redis(redisUrl, { db, lazyConnect: true, maxRetriesPerRequest: 1 });

  return {
    async get(key) {
      return redis.get(key);
    },

    async set(key, value, ttlSeconds) {
      if (ttlSeconds && ttlSeconds > 0) {
        await redis.set(key, value, "EX", ttlSeconds);
      } else {
        await redis.set(key, value);
      }
    },

    async del(key) {
      await redis.del(key);
    },

    async getJson<T>(key: string): Promise<T | null> {
      const raw = await redis.get(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },

    async setJson(key, value, ttlSeconds) {
      await this.set(key, JSON.stringify(value), ttlSeconds);
    },

    async acquireLock(key, ttlSeconds = 60) {
      const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
      return result === "OK";
    },

    async releaseLock(key) {
      await redis.del(key);
    },

    async close() {
      await redis.quit();
    }
  };
}

export type { Redis };
