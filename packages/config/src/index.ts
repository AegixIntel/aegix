import { z } from "zod";

/** Parses boolean env values: "true"/"1" → true, anything else → false. */
function boolEnv(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") return v === "true" || v === "1";
  return false;
}

/** Delegates "" (unset-from-compose) to undefined for optional URL fields. */
function urlOrUndefined(v: unknown): unknown {
  return typeof v === "string" && v.trim() === "" ? undefined : v;
}

const envSchema = z.object({
  ENABLE_NETWORK_API: z.preprocess(boolEnv, z.boolean()).default(false),
  ENABLE_INDEXED_TRANSACTIONS: z.preprocess(boolEnv, z.boolean()).default(false),
  REPUTATION_POLICY_FILE: z.string().optional(),
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

  RPC_PRIMARY_URL: z.preprocess(urlOrUndefined, z.string().url().optional()),
  RPC_PRIMARY_NAME: z.string().optional(),
  RPC_SECONDARY_URL: z.preprocess(urlOrUndefined, z.string().url().optional()),
  RPC_SECONDARY_NAME: z.string().optional(),
  RPC_TERTIARY_URL: z.preprocess(urlOrUndefined, z.string().url().optional()),
  RPC_TERTIARY_NAME: z.string().optional(),

  RPC_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  RPC_CIRCUIT_COOLDOWN_MS: z.coerce.number().int().positive().default(30000),
  RPC_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),

  LLM_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
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

  // D8: wallet context profile. A read over persisted analysis results, so
  // it consumes no analysis quota; the per-minute limit bounds the read
  // itself and the kill switch retires the surface without touching D1-D7.
  ENABLE_WALLET_CONTEXT: z.preprocess(boolEnv, z.boolean()).default(true),
  /** Per-minute rate limit for wallet context reads (D8 §10). */
  WALLET_CONTEXT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),

  // D9: Ask AEGIX. The LLM explains deterministic output and decides none of
  // it, so every knob here bounds cost and blast radius rather than quality.
  // A provider is reached through LLM_BASE_URL/LLM_API_KEY/LLM_MODEL above;
  // Groq is configured by pointing LLM_BASE_URL at its OpenAI-compatible path.
  ENABLE_ASK_AEGIX: z.preprocess(boolEnv, z.boolean()).default(true),
  /** Per-minute rate limit for Ask AEGIX requests (D9 §26). */
  ASK_AEGIX_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(6),
  /** Daily Ask AEGIX questions per user; bounds provider spend (D9 §26). */
  ASK_AEGIX_DAILY_QUOTA: z.coerce.number().int().positive().default(25),
  /** Hard ceiling on a provider call, after which it is a TIMEOUT. */
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  /** Output ceiling; a response cut off by it is reported as TRUNCATED. */
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(900),
  ENABLE_MARKETS: z.preprocess(boolEnv, z.boolean()).default(true),
  MARKETS_BASE_URL: z.string().url().default("https://api.coinpaprika.com/v1"),
  MARKETS_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(15000),
  MARKETS_CACHE_SECONDS: z.coerce.number().int().min(1).max(300).default(60),
  MARKETS_DAILY_QUOTA: z.coerce.number().int().positive().default(200),
  MARKETS_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),

  // D14: Rewind and the Discovery Engine. All three default off, so an
  // existing deployment changes nothing until an operator opts in. Capture is
  // separate from the read API on purpose: a replay is only as old as the
  // first capture, so capture can be started well before Rewind is exposed.
  // See docs/milestone-d14-rewind-discovery.md.
  ENABLE_REWIND_CAPTURE: z.preprocess(boolEnv, z.boolean()).default(false),
  ENABLE_REWIND: z.preprocess(boolEnv, z.boolean()).default(false),
  ENABLE_DISCOVERY: z.preprocess(boolEnv, z.boolean()).default(false),
  // The daily-resolution scan, for series that only move in market sessions.
  // Its own flag because switching it on adds a second set of hypotheses.
  ENABLE_DISCOVERY_DAILY: z.preprocess(boolEnv, z.boolean()).default(false),
  // Publishes the head of the Discovery ID chain to public OpenTimestamps
  // calendars, which commit it to the Bitcoin chain. Sends one 32-byte hash
  // per calendar and nothing else.
  ENABLE_DISCOVERY_ANCHOR: z.preprocess(boolEnv, z.boolean()).default(false),
  DISCOVERY_ANCHOR_CALENDARS: z.string().default("https://a.pool.opentimestamps.org,https://b.pool.opentimestamps.org,https://finney.calendar.eternitywall.com"),
  REWIND_CAPTURE_INTERVAL_SECONDS: z.coerce.number().int().min(300).max(3600).default(900),
  REWIND_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  // D14 series sources. Each one is a separate opt-in because each has a
  // different cost and a different standing: tokenized stocks are read from
  // RPC_URL, narrative volume from GDELT's public API, and options from
  // Cboe's delayed website feed, which carries no redistribution licence.
  // Narrative has two readings from two GDELT indexes, each with its own
  // flag: the DOC 2.0 volume share and the Context 2.0 hourly mention count.
  ENABLE_TOKENIZED_STOCK_CAPTURE: z.preprocess(boolEnv, z.boolean()).default(false),
  ENABLE_NARRATIVE_CAPTURE: z.preprocess(boolEnv, z.boolean()).default(false),
  ENABLE_NARRATIVE_CONTEXT_CAPTURE: z.preprocess(boolEnv, z.boolean()).default(false),
  ENABLE_OPTIONS_CAPTURE: z.preprocess(boolEnv, z.boolean()).default(false),
  // Sector and commodity fund prices, from the same Cboe feed as options and
  // with the same standing: delayed, and no redistribution licence.
  ENABLE_SECTOR_CAPTURE: z.preprocess(boolEnv, z.boolean()).default(false),
  // Stores a signal capture per news topic and per fund after their sources
  // sweep, so Rewind can replay them. Needs ENABLE_NARRATIVE_CONTEXT_CAPTURE
  // or ENABLE_SECTOR_CAPTURE: with neither, there is nothing to read.
  ENABLE_CONTEXT_SIGNAL_CAPTURE: z.preprocess(boolEnv, z.boolean()).default(false),
  // D15: the market intelligence engines, see
  // docs/milestone-d15-market-intelligence-engines.md. All default off. The
  // anomaly capture writes signal captures from then on; the other four only
  // read what the ledger and the captures already hold.
  ENABLE_ANOMALY_CAPTURE: z.preprocess(boolEnv, z.boolean()).default(false),
  ENABLE_ANOMALY_DETECTION: z.preprocess(boolEnv, z.boolean()).default(false),
  ENABLE_NARRATIVE_RADAR: z.preprocess(boolEnv, z.boolean()).default(false),
  ENABLE_SIGNAL_ENGINE: z.preprocess(boolEnv, z.boolean()).default(false),
  ENABLE_CROSS_MARKET: z.preprocess(boolEnv, z.boolean()).default(false),
  NARRATIVE_BASE_URL: z.string().url().default("https://api.gdeltproject.org/api/v2"),
  OPTIONS_BASE_URL: z.string().url().default("https://cdn.cboe.com/api/global"),
  SERIES_SOURCE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(20000),

  // D6 Block 2: wallet-only auth (D6-P), developer intelligence (D6-E),
  // population commonality (D6-G), correlation alerts (D6-F), webhooks (D6-H).
  // See docs/d6-block2.md.
  AUTH_DOMAIN: z.string().default("http://localhost:3000"),
  AUTH_APP_URI: z.string().default("http://localhost:3000"),
  WALLET_AUTH_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  WALLET_AUTH_MAX_PENDING_PER_WALLET: z.coerce.number().int().positive().default(5),
  WALLET_AUTH_RATE_LIMIT_CHALLENGE: z.coerce.number().int().positive().default(10),
  WALLET_AUTH_RATE_LIMIT_VERIFY: z.coerce.number().int().positive().default(20),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  /** Temporary Supabase JWT bridge for pre-wallet identities (D6-P §35). */
  ENABLE_LEGACY_AUTH: z.preprocess(boolEnv, z.boolean()).default(true),

  ENABLE_DEVELOPER_INTELLIGENCE_API: z.preprocess(boolEnv, z.boolean()).default(true),
  DEVELOPER_INTELLIGENCE_QUOTA_UNITS_WALLET: z.coerce.number().int().positive().default(1),
  DEVELOPER_INTELLIGENCE_QUOTA_UNITS_COMPARE: z.coerce.number().int().positive().default(2),

  ENABLE_POPULATION_COMMONALITY: z.preprocess(boolEnv, z.boolean()).default(false),
  COMMONALITY_MIN_POPULATION: z.coerce.number().int().positive().default(20),
  COMMONALITY_AGGREGATION_BATCH: z.coerce.number().int().positive().default(50),
  COMMONALITY_VERSION: z.string().default("population-commonality-v1.1.0"),
  /** Stale snapshot fallback: aggregates older than this are not trusted
   *  (D6-I2 §21): the engine falls back to static commonality instead of
   *  treating old statistics as current truth. */
  COMMONALITY_MAX_SNAPSHOT_AGE_HOURS: z.coerce.number().int().positive().default(336),

  ENABLE_CORRELATION_MONITOR_ALERTS: z.preprocess(boolEnv, z.boolean()).default(true),
  MAX_MONITOR_CORRELATION_CANDIDATES: z.coerce.number().int().positive().default(20),
  CORRELATION_ALERT_ENTER_STRONG: z.coerce.number().int().nonnegative().default(60),
  CORRELATION_ALERT_EXIT_STRONG: z.coerce.number().int().nonnegative().default(45),
  CORRELATION_ALERT_MIN_DELTA: z.coerce.number().int().positive().default(10),

  ENABLE_WEBHOOK_DELIVERY: z.preprocess(boolEnv, z.boolean()).default(true),
  /** Max active webhook endpoints per user; the free-plan baseline (D11). */
  MAX_ACTIVE_WEBHOOKS_PER_USER: z.coerce.number().int().nonnegative().default(5),
  WEBHOOK_ENCRYPTION_KEY: z.string().default(""),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  WEBHOOK_DISABLE_AFTER_FAILURES: z.coerce.number().int().positive().default(10),
  WEBHOOK_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WEBHOOK_PAYLOAD_MAX_BYTES: z.coerce.number().int().positive().default(65536),
  WEBHOOK_ALLOWED_PORTS: z.string().default("80,443"),
  WEBHOOK_DEV_ALLOW_PRIVATE: z.preprocess(boolEnv, z.boolean()).default(false),

  // D11: billing / entitlements. See docs/milestone-d11.md.
  //
  // The free plan is defined as the limits above (FREE_USER_DAILY_LIMIT,
  // COMPARE_DAILY_USER_LIMIT, MAX_ACTIVE_MONITORS_PER_USER, …), so turning
  // billing on changes nothing for an identity without a subscription. Only
  // paid plans scale those numbers, and they scale them from the same knobs.
  ENABLE_BILLING: z.preprocess(boolEnv, z.boolean()).default(true),
  /**
   * Payment processor. `manual` is the only implementation in this baseline
   * (architecture.md PR-12: the beta operates without payment
   * infrastructure); paid plans are granted by an operator and recorded in
   * the billing ledger like any other transition.
   */
  BILLING_PROVIDER: z.enum(["manual"]).default("manual"),
  BILLING_CURRENCY: z.string().length(3).default("USD"),
  /** Trial length applied to a first paid subscription; 0 disables trials. */
  BILLING_TRIAL_DAYS: z.coerce.number().int().nonnegative().default(0),
  /**
   * How long a PAST_DUE subscription keeps its paid entitlements before
   * degrading to free. A failed payment never deletes data — it only stops
   * the identity spending above the free baseline.
   */
  BILLING_GRACE_DAYS: z.coerce.number().int().nonnegative().default(7),
  /** Page size cap for billing ledger and invoice listings. */
  BILLING_HISTORY_LIMIT: z.coerce.number().int().positive().max(200).default(50),

  /** API request body cap (D6-J §62): field-level limits in route schemas
   *  remain the real bounds; this is a coarse ceiling against oversized
   *  payloads (labels/notes are far smaller). */
  API_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(65536),

  /** Reverse-proxy hops in front of the API whose X-Forwarded-For entries are
   *  trusted for the client IP (global rate limit, per-IP admission, anonymous
   *  quota). 0 uses the socket address. Behind the production nginx proxy this
   *  must be 1, or every visitor shares the proxy's IP and one set of limits. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

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
  if (config.GROQ_API_KEY && !config.LLM_API_KEY) {
    config.LLM_API_KEY = config.GROQ_API_KEY;
    config.LLM_BASE_URL = env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1";
    config.LLM_MODEL = env.LLM_MODEL ?? "llama-3.3-70b-versatile";
  }

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
    // Webhook delivery is ON by default and its signing secrets are
    // encrypted at rest with this key — running without it silently
    // disables webhook creation in production.
    if (config.ENABLE_WEBHOOK_DELIVERY && !config.WEBHOOK_ENCRYPTION_KEY) {
      missing.push(["WEBHOOK_ENCRYPTION_KEY", ""]);
    }
    if (missing.length > 0) {
      throw new Error(
        `Production configuration error: ${missing.map(([k]) => k).join(", ")} must be explicitly set (no unsafe defaults)`
      );
    }
    if (config.ENABLE_LEGACY_AUTH && (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_KEY)) {
      throw new Error("Production configuration error: SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
    }

    // D6-J §66: fail fast on dangerous production combinations. Email
    // notifications must never silently run with a broken provider, and the
    // wallet-auth domain must not be the localhost default.
    if (config.EMAIL_ENABLED && config.EMAIL_PROVIDER === "smtp" && !config.EMAIL_SMTP_HOST) {
      throw new Error("Production configuration error: EMAIL_ENABLED with EMAIL_PROVIDER=smtp requires EMAIL_SMTP_HOST");
    }
    const authDomain = new URL(config.AUTH_DOMAIN);
    const authAppUri = new URL(config.AUTH_APP_URI);
    const corsOrigins = config.CORS_ORIGIN.split(",").map((origin) => new URL(origin.trim()));
    if (authDomain.protocol !== "https:" || authAppUri.protocol !== "https:" || corsOrigins.some((origin) => origin.protocol !== "https:")) {
      throw new Error("Production configuration error: AUTH_DOMAIN, AUTH_APP_URI, and CORS_ORIGIN must use HTTPS");
    }
    if (authDomain.origin !== authAppUri.origin || !corsOrigins.some((origin) => origin.origin === authDomain.origin)) {
      throw new Error("Production configuration error: wallet-auth and CORS origins must include the same public web origin");
    }
    if (config.ENABLE_WEBHOOK_DELIVERY && config.WEBHOOK_DEV_ALLOW_PRIVATE) {
      throw new Error("Production configuration error: WEBHOOK_DEV_ALLOW_PRIVATE must be false in production (SSRF policy)");
    }

    // RPC resilience: warn if no failover providers are configured.
    if (!config.RPC_PRIMARY_URL && !config.RPC_SECONDARY_URL && !config.RPC_TERTIARY_URL) {
      console.warn("[AEGIX] WARNING: No RPC failover providers configured (RPC_PRIMARY_URL/RPC_SECONDARY_URL/RPC_TERTIARY_URL). A single RPC_URL means no automatic failover on provider failure.");
    }
  }

  return config;
}
