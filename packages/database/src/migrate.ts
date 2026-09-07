/**
 * Minimal migration runner for AEGIX.
 *
 * Applies .sql files from packages/database/migrations in order, tracking
 * applied migrations in a schema_migrations table.
 *
 * Usage: pnpm --filter @aegix/database migrate
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../migrations");

const databaseUrl = process.env.DATABASE_URL ?? (process.env.NODE_ENV === "production" ? "" : "postgres://postgres:postgres@localhost:5432/aegix");
if (!databaseUrl) throw new Error("DATABASE_URL is required for production migrations");
const sql = postgres(databaseUrl, { max: 1 });

async function run(): Promise<void> {
  // Serialize migration runners across deploy replicas. The session-scoped
  // lock is automatically released if the process or connection terminates.
  await sql`select pg_advisory_lock(hashtext('aegix:schema-migrations'))`;
  await sql`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    (await sql<Array<{ version: string }>>`select version from schema_migrations`).map((r) => r.version)
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(path.join(migrationsDir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (version) values (${file})`;
    });
    console.log(`applied ${file}`);
  }

  console.log("migrations up to date");
  await sql`select pg_advisory_unlock(hashtext('aegix:schema-migrations'))`;
}

run()
  .catch((err) => {
    console.error("migration failed:", err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
