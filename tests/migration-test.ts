import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createDb } from "@aegix/database";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";

const runFile = promisify(execFile);
async function migrate(): Promise<void> {
  await runFile("pnpm", ["--filter", "@aegix/database", "migrate"], {
    env: process.env,
    timeout: 60_000
  });
}

async function reset(sql: ReturnType<typeof createDb>): Promise<void> {
  await sql.unsafe("drop schema public cascade; create schema public;");
}

async function installD7Schema(sql: ReturnType<typeof createDb>): Promise<void> {
  await sql`
    create table schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const migrationDir = path.resolve("packages/database/migrations");
  const files = (await readdir(migrationDir))
    .filter((file) => file.endsWith(".sql") && file < "0009_")
    .sort();
  for (const file of files) {
    const body = await readFile(path.join(migrationDir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (version) values (${file})`;
    });
  }
  assert.equal(files.length, 8, "D7 baseline contains migrations 0001..0008");
}

async function main(): Promise<void> {
  const safe = requireSafeTestDatabaseReset();
  const initial = createDb(safe.databaseUrl);
  await reset(initial);
  await initial.end();

  // Both runners start together; the advisory lock must serialize them.
  await Promise.all([migrate(), migrate()]);
  await migrate();

  const sql = createDb(safe.databaseUrl);
  try {
    const fixtureId = randomUUID();
    await sql`insert into profiles (id, primary_wallet) values (${fixtureId}, ${`migration-fixture-${fixtureId}`})`;
    await migrate();
    const [fixture] = await sql<Array<{ id: string }>>`select id from profiles where id = ${fixtureId}`;
    assert.equal(fixture?.id, fixtureId, "existing fixture data survives idempotent migrations");
    const [count] = await sql<Array<{ count: string }>>`select count(*)::text as count from schema_migrations`;
    assert.ok(Number(count?.count) >= 10, "all migrations are recorded");
    assert.equal(Number(count?.count), 10, "exactly ten migrations are recorded");
  } finally {
    await sql.end();
  }


  // Real upgrade shape: install the committed D7 schema (0001..0008), seed
  // existing user + notification data, then let the actual runner apply the
  // migrations added since (0009 keyset index, 0010 billing).
  const d7 = createDb(safe.databaseUrl);
  const d7User = randomUUID();
  let d7NotificationId = "";
  try {
    await reset(d7);
    await installD7Schema(d7);
    await d7`insert into profiles (id, primary_wallet) values (${d7User}, ${`d7-wallet-${d7User}`})`;
    const [row] = await d7<Array<{ id: string }>>`
      insert into notifications (user_id, channel, type, title, body, severity, status, idempotency_key)
      values (${d7User}, 'IN_APP', 'TEST', 'D7 fixture', 'preserve me', 'INFO', 'SENT', ${randomUUID()})
      returning id
    `;
    d7NotificationId = String(row!.id);
  } finally {
    await d7.end();
  }

  await migrate();
  await migrate();

  const upgraded = createDb(safe.databaseUrl);
  try {
    const [preserved] = await upgraded<Array<{ body: string }>>`
      select body from notifications where id = ${d7NotificationId} and user_id = ${d7User}
    `;
    assert.equal(preserved?.body, "preserve me", "D7 notification data survives migrations 0009-0010");
    const [index] = await upgraded<Array<{ exists: boolean }>>`
      select to_regclass('public.idx_notifications_in_app_keyset') is not null as exists
    `;
    assert.equal(index?.exists, true, "migration 0009 keyset index exists after upgrade");
    const [plans] = await upgraded<Array<{ count: string }>>`select count(*)::text as count from plans`;
    assert.equal(Number(plans?.count), 3, "migration 0010 seeds the shipped plan catalog");
    // D11 must be inert for identities that were already here: the upgraded
    // D7 user has no subscription row, so nothing about its limits changes.
    const [subscriptions] = await upgraded<Array<{ count: string }>>`
      select count(*)::text as count from subscriptions where user_id = ${d7User}
    `;
    assert.equal(Number(subscriptions?.count), 0, "migration 0010 creates no subscription for existing users");
    const [profile] = await upgraded<Array<{ plan: string }>>`select plan from profiles where id = ${d7User}`;
    assert.equal(profile?.plan, "free", "an existing profile stays on the free plan");
    const [count] = await upgraded<Array<{ count: string }>>`select count(*)::text as count from schema_migrations`;
    assert.equal(Number(count?.count), 10, "D7 upgrade records migrations 0009-0010 exactly once");
    console.log("10 migrations passed fresh, concurrent, idempotent, D7-upgrade, index, and data-preservation checks");
  } finally {
    await upgraded.end();
  }
}

void main();
