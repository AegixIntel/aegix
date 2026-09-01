import { z } from "zod";

/** Parses boolean env values: "true"/"1" → true, anything else → false. */
function boolEnv(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") return v === "true" || v === "1";
  return false;
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().url().default("postgres://postgres:postgres@localhost:5432/aegix"),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),

  REDIS_URL: z.string().default("redis://localhost:6379"),

  RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  RPC_WEBSOCKET_URL: z.string().url().optional(),
  RPC_RATE_LIMIT_PER_SECOND: z.coerce.number().int().positive().default(100),

  RPC_PRIMARY_URL: z.string().url().optional(),
  RPC_PRIMARY_NAME: z.string().optional(),
  RPC_SECONDARY_URL: z.string().url().optional(),
  RPC_SECONDARY_NAME: z.string().optional(),
  RPC_TERTIARY_URL: z.string().url().optional(),
  RPC_TERTIARY_NAME: z.string().optional(),

  RPC_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  RPC_CIRCUIT_COOLDOWN_MS: z.coerce.number().int().positive().default(30000),
  RPC_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),

  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_MODEL: z.string().default("gpt-4o-mini"),

  JWT_SECRET: z.string().min(16).default("development-only-secret-change-me"),

  ANALYSIS_MAX_TRANSACTIONS: z.coerce.number().int().positive().default(2000),
  ANALYSIS_MAX_RPC_CALLS: z.coerce.number().int().positive().default(2500),
  ANALYSIS_MAX_HISTORY_DAYS: z.coerce.number().int().positive().default(365),
  ANALYSIS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  ANALYSIS_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(3),
  ANALYSIS_MAX_SIGNATURE_PAGES: z.coerce.number().int().positive().default(5),
  ANALYSIS_RPC_CONCURRENCY: z.coerce.number().int().positive().default(2),
  ANALYSIS_RPC_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(250),
  ANALYSIS_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  ANALYSIS_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),

  QUEUE_PREFIX: z.string().default("aegix"),
  REDIS_QUEUE_DB: z.coerce.number().int().min(0).max(15).default(1),
  REDIS_CACHE_DB: z.coerce.number().int().min(0).max(15).default(2),

  FREE_ANON_DAILY_LIMIT: z.coerce.number().int().nonnegative().default(3),
  FREE_USER_DAILY_LIMIT: z.coerce.number().int().nonnegative().default(10),

  // D3-C: public admission control
  MAX_QUEUE_DEPTH: z.coerce.number().int().nonnegative().default(50),
  MAX_PENDING_PER_USER: z.coerce.number().int().nonnegative().default(3),
  MAX_PENDING_PER_IP: z.coerce.number().int().nonnegative().default(5),
  MAX_ACTIVE_GLOBAL: z.coerce.number().int().nonnegative().default(30),

  // D3-J: feature flags and kill switch. Boolean env vars are parsed
  // explicitly — z.coerce.boolean() would turn "false" into true.
  ENABLE_REGISTRATION: z.preprocess(boolEnv, z.boolean()).default(true),
  ENABLE_NEW_ANALYSES: z.preprocess(boolEnv, z.boolean()).default(true),
  ENABLE_ATTACK_MY_WALLET: z.preprocess(boolEnv, z.boolean()).default(true),
  ENABLE_SAVE_WALLET: z.preprocess(boolEnv, z.boolean()).default(true),

  // D4: privacy threat monitor — kill switches, schedules, budgets, noise
  // suppression. See docs/milestone-d4.md (D4-A, D4-H, D4-I).
  ENABLE_MONITORING: z.preprocess(boolEnv, z.boolean()).default(true),
  ENABLE_MONITOR_SCHEDULER: z.preprocess(boolEnv, z.boolean()).default(true),
  ENABLE_EMAIL_NOTIFICATIONS: z.preprocess(boolEnv, z.boolean()).default(false),
  // D5-J §49: transactional email provider (server-side secrets only).
  EMAIL_ENABLED: z.preprocess(boolEnv, z.boolean()).default(false),
  EMAIL_PROVIDER: z.enum(["console", "smtp"]).default("console"),
  EMAIL_FROM: z.string().default("AEGIX <no-reply@aegix.local>"),
  EMAIL_SMTP_HOST: z.string().default(""),
  EMAIL_SMTP_PORT: z.coerce.number().int().positive().default(587),
  EMAIL_SMTP_SECURE: z.preprocess(boolEnv, z.boolean()).default(false),
  EMAIL_SMTP_USER: z.string().default(""),
  EMAIL_SMTP_PASS: z.string().default(""),
  EMAIL_SMTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  MONITOR_ALLOWED_SCHEDULES: z.string().default("DAILY,EVERY_12_HOURS,EVERY_6_HOURS"),
  MONITOR_DEFAULT_SCHEDULE: z.string().default("DAILY"),
  MONITOR_TEST_SCHEDULES_ENABLED: z.preprocess(boolEnv, z.boolean()).default(false),
  MONITOR_FRESHNESS_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  MONITOR_SCHEDULER_CRON: z.string().default("*/5 * * * *"),
  MAX_ACTIVE_MONITORS_PER_USER: z.coerce.number().int().positive().default(3),
  MAX_MONITOR_JOBS_PER_HOUR: z.coerce.number().int().positive().default(120),
  MAX_ACTIVE_MONITOR_JOBS: z.coerce.number().int().positive().default(10),
  MAX_MONITOR_QUEUE_DEPTH: z.coerce.number().int().positive().default(100),
  MONITOR_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  MONITOR_CHECK_RETRY_LIMIT: z.coerce.number().int().positive().default(3),
  MONITOR_EVENT_COOLDOWN_HOURS: z.coerce.number().int().positive().default(24),
  MONITOR_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  MONITOR_SCORE_DELTA_THRESHOLD: z.coerce.number().int().nonnegative().default(10),
  MONITOR_EVENT_EXPIRY_DAYS: z.coerce.number().int().positive().default(30),

  // D5: cross-wallet correlation — kill switches, budgets (D5-B, D5-L §86, §99).
  ENABLE_CORRELATION_ANALYSIS: z.preprocess(boolEnv, z.boolean()).default(true),
  ENABLE_MULTI_HOP_GRAPH: z.preprocess(boolEnv, z.boolean()).default(true),
  ENABLE_CLUSTER_HYPOTHESES: z.preprocess(boolEnv, z.boolean()).default(true),
  /** Bounded cross-wallet candidate scan during analysis (D5-B). */
  MAX_CORRELATION_CANDIDATE_WALLETS: z.coerce.number().int().positive().default(50),
  /** Secondary fetch budgets for multi-hop exploration (D5-L §86). */
  MAX_SECONDARY_WALLETS: z.coerce.number().int().positive().default(20),
  MAX_SECONDARY_TRANSACTIONS: z.coerce.number().int().positive().default(5000),
  MAX_SECONDARY_RPC_CALLS: z.coerce.number().int().positive().default(100),
  MAX_GRAPH_ANALYSIS_TIME_MS: z.coerce.number().int().positive().default(30000),
  /** D5-G §33: bounded multi-hop graph expansion (versioned limits). */
  GRAPH_MAX_DEPTH: z.coerce.number().int().positive().default(4),
  GRAPH_MAX_NODES: z.coerce.number().int().positive().default(200),
  GRAPH_MAX_EDGES: z.coerce.number().int().positive().default(800),
  GRAPH_MAX_TIME_MS: z.coerce.number().int().positive().default(5000),
  /** D5-H §60: max members per relationship cluster. */
  CLUSTER_MAX_SIZE: z.coerce.number().int().positive().default(15),
  /** D5-I §6: inferred-edge admission thresholds (correlation → graph). */
  MIN_INFERRED_EDGE_SCORE: z.coerce.number().int().nonnegative().default(40),
  MIN_INFERRED_EDGE_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
  MIN_INFERRED_EDGE_EVIDENCE_FAMILIES: z.coerce.number().int().nonnegative().default(2),
  /** D5-I §7: strong direct exception score for single-family admission. */
  INFERRED_EDGE_STRONG_DIRECT_SCORE: z.coerce.number().int().nonnegative().default(70),
  /** D5-L §92-§93: comparison-specific limits (admission + rate limit). */
  COMPARE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(6),
  COMPARE_DAILY_ANON_LIMIT: z.coerce.number().int().positive().default(10),
  COMPARE_DAILY_USER_LIMIT: z.coerce.number().int().positive().default(50),
  /** Hub penalty (D5-G §49). */
  HUB_DEGREE_THRESHOLD: z.coerce.number().int().positive().default(50),
  HUB_PENALTY_FACTOR: z.coerce.number().min(0).max(1).default(0.5),
  /** Correlation pair cache TTL (D5-L §87). */
  CORRELATION_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  // D6 Block 1: saved comparisons (D6-A) + developer API (D6-B..D6-D).
  // Feature flags default ON; kill switches can disable without touching the
  // D1-D5 product surfaces (same pattern as ENABLE_MONITORING).
  ENABLE_SAVED_COMPARISONS: z.preprocess(boolEnv, z.boolean()).default(true),
  ENABLE_DEVELOPER_API: z.preprocess(boolEnv, z.boolean()).default(true),
  /** Max active (non-revoked, non-expired) API keys per user (D6-C §60). */
  MAX_ACTIVE_API_KEYS_PER_USER: z.coerce.number().int().positive().default(10),
  /** Optional per-key lifetime in days; null = no expiration (D6-C §49). */
  API_KEY_DEFAULT_TTL_DAYS: z.coerce.number().int().nonnegative().default(0),
  /** Per-minute rate limit for developer API requests (D6-D §82). */
  DEVELOPER_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  /** Daily developer quota per user (D6-D §66-§69); keys cannot multiply it. */
  DEVELOPER_DAILY_QUOTA: z.coerce.number().int().positive().default(500),

  CORS_ORIGIN: z.string().default("http://localhost:3000")
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const config = parsed.data;

  // Fail fast in production: never silently run with unsafe defaults, see
  // milestone D3-J §57. Development keeps the ergonomic defaults.
  if (config.NODE_ENV === "production") {
    const required = [
      ["DATABASE_URL", config.DATABASE_URL],
      ["REDIS_URL", config.REDIS_URL],
      ["RPC_URL", config.RPC_URL],
      ["CORS_ORIGIN", config.CORS_ORIGIN]
    ];
    const missing = required.filter(([, v]) => !v || v.includes("localhost") && v.startsWith("postgres://postgres:postgres"));
    if (missing.length > 0) {
      throw new Error(
        `Production configuration error: ${missing.map(([k]) => k).join(", ")} must be explicitly set (no unsafe defaults)`
      );
    }
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_KEY) {
      throw new Error("Production configuration error: SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
    }
  }

  return config;
}
