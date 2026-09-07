const SAFE_DATABASE_NAME = /^(?:aegix_test(?:_[a-z0-9][a-z0-9_-]*)?|aegix_loadtest_[a-z0-9][a-z0-9_-]*)$/;
const SAFE_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

export interface TestDatabaseEnvironment {
  databaseUrl: string;
  databaseName: string;
  hostname: string;
}

/**
 * Fail-closed guard for tests that destroy database state.
 *
 * The returned URL may be passed to a client, but must never be logged because
 * it can contain credentials. This helper intentionally validates before any
 * connection is created or reset statement is issued.
 */
export function requireSafeTestDatabaseReset(
  env: NodeJS.ProcessEnv = process.env,
  options: { databaseUrl?: string; allowedHosts?: readonly string[] } = {}
): TestDatabaseEnvironment {
  if (env.NODE_ENV === undefined) env.NODE_ENV = "test";
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing destructive database reset when NODE_ENV=production");
  }
  if (env.NODE_ENV !== "test") {
    throw new Error(`Refusing destructive database reset when NODE_ENV=${env.NODE_ENV}`);
  }
  if (env.AEGIX_ALLOW_TEST_DB_RESET !== "true") {
    throw new Error("Refusing destructive database reset without AEGIX_ALLOW_TEST_DB_RESET=true");
  }

  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Refusing destructive database reset: DATABASE_URL is required");

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Refusing destructive database reset: DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Refusing destructive database reset: DATABASE_URL must use PostgreSQL");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!SAFE_DATABASE_NAME.test(databaseName)) {
    throw new Error(`Refusing destructive database reset: database name \"${databaseName || "(empty)"}\" is not allowlisted`);
  }

  const allowedHosts = new Set([...SAFE_DATABASE_HOSTS, ...(options.allowedHosts ?? [])]);
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(`Refusing destructive database reset: host \"${parsed.hostname || "(empty)"}\" is not allowlisted`);
  }

  return { databaseUrl, databaseName, hostname: parsed.hostname };
}
