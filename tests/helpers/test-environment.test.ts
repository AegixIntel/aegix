import assert from "node:assert/strict";
import { test } from "node:test";
import { requireSafeTestDatabaseReset } from "./test-environment.js";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    AEGIX_ALLOW_TEST_DB_RESET: "true",
    DATABASE_URL: "postgres://user:password@localhost:5432/aegix_test",
    ...overrides
  };
}

test("defaults an undefined NODE_ENV to test", () => {
  const input = env({ NODE_ENV: undefined });
  assert.equal(requireSafeTestDatabaseReset(input).databaseName, "aegix_test");
  assert.equal(input.NODE_ENV, "test");
});

test("rejects production and development environments", () => {
  assert.throws(() => requireSafeTestDatabaseReset(env({ NODE_ENV: "production" })), /NODE_ENV=production/);
  assert.throws(() => requireSafeTestDatabaseReset(env({ NODE_ENV: "development" })), /NODE_ENV=development/);
});

test("rejects missing opt-in and invalid URLs", () => {
  assert.throws(() => requireSafeTestDatabaseReset(env({ AEGIX_ALLOW_TEST_DB_RESET: undefined })), /AEGIX_ALLOW_TEST_DB_RESET/);
  assert.throws(() => requireSafeTestDatabaseReset(env({ DATABASE_URL: "not-a-url" })), /valid URL/);
  assert.throws(() => requireSafeTestDatabaseReset(env({ DATABASE_URL: "mysql://localhost/aegix_test" })), /PostgreSQL/);
});

test("uses a strict database-name allowlist", () => {
  for (const name of ["aegix", "contest", "latest", "aegix_loadtest"]) {
    assert.throws(
      () => requireSafeTestDatabaseReset(env({ DATABASE_URL: `postgres://localhost/${name}` })),
      /database name/
    );
  }
  for (const name of ["aegix_test", "aegix_test_ci", "aegix_loadtest_ci"]) {
    assert.equal(
      requireSafeTestDatabaseReset(env({ DATABASE_URL: `postgres://localhost/${name}` })).databaseName,
      name
    );
  }
});

test("rejects production and other non-local hosts by default", () => {
  assert.throws(
    () => requireSafeTestDatabaseReset(env({ DATABASE_URL: "postgres://db.production.example/aegix_test" })),
    /host/
  );
  assert.equal(
    requireSafeTestDatabaseReset(env({ DATABASE_URL: "postgres://postgres/aegix_test_ci" })).hostname,
    "postgres"
  );
});
