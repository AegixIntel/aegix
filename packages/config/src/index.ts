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

  CORS_ORIGIN: z.string().default("http://localhost:3000")
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
