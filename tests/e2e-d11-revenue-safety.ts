import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ed25519 } from "@noble/curves/ed25519";
import base58 from "bs58";
import { createDb, createBillingRepo, type Sql } from "@aegix/database";
import { loadConfig } from "@aegix/config";
import type { AegixLogger } from "@aegix/logging";
import { buildServer } from "../apps/api/src/server.js";
import { runBillingLifecycle } from "../apps/worker/src/processors/billing.js";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";

/**
 * D11 revenue safety: a manually provisioned subscription must not renew on
 * time alone, and a confirmed invoice payment must extend it exactly once.
 *
 * The operator actions are exercised through the real CLI (`scripts/grant-plan.ts`)
 * rather than an in-process copy, so the command an operator actually runs is
 * what the test covers.
 */

const runFile = promisify(execFile);

const MARKETS_FREE_QUOTA = 2;
const FREE_MONITOR_LEVEL = 1;
const OVERRIDES = {
  MARKETS_DAILY_QUOTA: String(MARKETS_FREE_QUOTA),
  MAX_ACTIVE_MONITORS_PER_USER: String(FREE_MONITOR_LEVEL),
  BILLING_GRACE_DAYS: "7"
};

function cliEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return { ...process.env, ...OVERRIDES, DATABASE_URL: databaseUrl, NODE_ENV: "test", AEGIX_ALLOW_TEST_DB_RESET: "true" };
}

/** Runs the operator CLI exactly as an operator would, and returns stdout. */
async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await runFile(process.execPath, ["--import", "tsx", "scripts/grant-plan.ts", ...args], {
    cwd: process.cwd(),
    env,
    timeout: 120_000
  });
  return stdout;
}

async function authenticate(config: ReturnType<typeof loadConfig>) {
  const key = ed25519.utils.randomPrivateKey();
  const address = base58.encode(ed25519.getPublicKey(key));
  const app = await buildServer({ config });
  try {
    const challenge = await app.inject({ method: "POST", url: "/v1/auth/wallet/challenge", payload: { wallet: address } });
    const data = challenge.json().data;
    const verification = await app.inject({
      method: "POST",
      url: "/v1/auth/wallet/verify",
      payload: {
        wallet: address,
        challengeId: data.challengeId,
        nonce: data.nonce,
        signature: base58.encode(ed25519.sign(new TextEncoder().encode(data.message), key))
      }
    });
    assert.equal(verification.statusCode, 200);
    const auth = verification.json().data;
    return { address, userId: auth.user.id as string, headers: { authorization: `Bearer ${auth.token}` } };
  } finally {
    await app.close();
  }
}

/** A cold server per read: the entitlement cache TTL must not mask a change. */
async function subscriptionView(config: ReturnType<typeof loadConfig>, headers: Record<string, string>) {
  const app = await buildServer({ config });
  try {
    const response = await app.inject({ url: "/v1/billing/subscription", headers });
    assert.equal(response.statusCode, 200);
    return response.json();
  } finally {
    await app.close();
  }
}

/** Monitor counts by status, straight from storage (no repository shortcut). */
async function monitorStatusCounts(sql: Sql, userId: string): Promise<Record<string, number>> {
  const rows = await sql<Array<{ status: string; count: string }>>`
    select status, count(*)::text as count
    from privacy_monitors
    where user_id = ${userId}
    group by status
  `;
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

async function main(): Promise<void> {
  const safe = requireSafeTestDatabaseReset();
  const config = loadConfig({ ...process.env, ...OVERRIDES });
  const sql = createDb(safe.databaseUrl);
  const repo = createBillingRepo(sql);
  const env = cliEnv(safe.databaseUrl);
  const createdUsers: string[] = [];
  const createdWallets: string[] = [];

  try {
    // ---- FREE → operator grant Pro through the CLI ----
    const paid = await authenticate(config);
    createdUsers.push(paid.userId);
    const free = await subscriptionView(config, paid.headers);
    assert.equal(free.plan.code, "free", "a fresh identity is on the free plan");

    await runCli(["--user", paid.userId, "--plan", "pro"], env);
    const granted = await subscriptionView(config, paid.headers);
    assert.equal(granted.plan.code, "pro");
    assert.equal(granted.status, "ACTIVE");
    assert.equal(granted.entitlements["monitors.active"], 5, "pro scales the free monitor level");
    assert.equal(granted.entitlements["markets.daily"], MARKETS_FREE_QUOTA * 10);

    // ---- Uncovered monitors are set up before the period is allowed to lapse ----
    const monitors: string[] = [];
    for (let i = 0; i < FREE_MONITOR_LEVEL + 2; i++) {
      const address = `e2e-d11-rs-${paid.userId.slice(0, 8)}-${i}`;
      const [wallet] = await sql<Array<{ id: string }>>`
        insert into wallets (chain, address) values ('solana', ${address}) returning id::text
      `;
      createdWallets.push(wallet!.id);
      const [monitor] = await sql<Array<{ id: string }>>`
        insert into privacy_monitors (user_id, wallet_id, status, schedule_type, next_check_at)
        values (${paid.userId}, ${wallet!.id}, 'ACTIVE', 'DAILY', now() + interval '1 day')
        returning id::text
      `;
      monitors.push(monitor!.id);
    }

    // ---- Reach the period boundary without confirming payment ----
    const closedStart = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const closedEnd = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await sql`
      update subscriptions
      set current_period_start = ${closedStart}::timestamptz,
          current_period_end = ${closedEnd}::timestamptz
      where user_id = ${paid.userId}
    `;

    const swept = await runBillingLifecycle({ config, sql, logger: silentLogger() });
    assert.equal(swept.renewed, 0, "an unpaid manual period must not renew");
    assert.equal(swept.expired, 1, "it ends the subscription instead");
    assert.equal(swept.invoiced, 1, "the closed period is invoiced so it can be settled");

    const [row] = await sql<Array<{ status: string }>>`
      select status from subscriptions where user_id = ${paid.userId}
    `;
    assert.equal(row?.status, "EXPIRED", "period expiry returns the identity to free");

    // Nothing renewed: no unpaid next period exists, and paid limits are gone.
    const expired = await subscriptionView(config, paid.headers);
    assert.equal(expired.status, "EXPIRED");
    assert.equal(expired.plan.code, "free");
    assert.equal(expired.subscribedPlan.code, "pro", "the subscription row is retained");
    assert.equal(expired.degraded, true);
    assert.equal(expired.entitlements["markets.daily"], MARKETS_FREE_QUOTA, "free quota is enforced again");
    assert.equal(expired.entitlements["monitors.active"], FREE_MONITOR_LEVEL);

    // Monitors beyond the free level are held by the plan, never deleted.
    const expiryStatuses = await monitorStatusCounts(sql, paid.userId);
    assert.equal(expiryStatuses.ACTIVE ?? 0, FREE_MONITOR_LEVEL, "only the free level keeps running");
    assert.equal(expiryStatuses.ENTITLEMENT_PAUSED ?? 0, 2, "the uncovered monitors are held by the plan");
    const [{ count: retained }] = await sql<Array<{ count: string }>>`
      select count(*)::text as count from privacy_monitors where user_id = ${paid.userId}
    `;
    assert.equal(Number(retained), monitors.length, "no monitor is deleted on expiry");

    const invoices = await repo.listInvoices(paid.userId, 10);
    assert.equal(invoices.length, 1);
    const invoice = invoices[0]!;
    assert.equal(invoice.status, "OPEN");
    assert.equal(invoice.total_cents, 4900);

    // ---- The operator confirms payment; the subscription extends one period ----
    const settlement = await runCli(["--invoice", invoice.id, "--mark-paid"], env);
    assert.match(settlement, /Status: PAID/);
    assert.match(settlement, /Extended through:/);

    const [settledInvoice] = await sql<Array<{ status: string; paid_at: string | null }>>`
      select status, paid_at from invoices where id = ${invoice.id}
    `;
    assert.equal(settledInvoice?.status, "PAID", "mark-paid changes OPEN → PAID");
    assert.ok(settledInvoice?.paid_at, "paid_at is persisted");

    const renewed = await subscriptionView(config, paid.headers);
    assert.equal(renewed.plan.code, "pro", "the paid period is active again");
    assert.equal(renewed.status, "ACTIVE");
    assert.equal(renewed.entitlements["markets.daily"], MARKETS_FREE_QUOTA * 10, "paid quotas are retained");
    assert.equal(renewed.entitlements["monitors.active"], 5);
    // The entitlement sweep resumes what the lapse held, and nothing else.
    await runBillingLifecycle({ config, sql, logger: silentLogger() });
    const restoredStatuses = await monitorStatusCounts(sql, paid.userId);
    assert.equal(restoredStatuses.ENTITLEMENT_PAUSED ?? 0, 0, "plan-held monitors are restored");
    assert.equal(restoredStatuses.ACTIVE ?? 0, monitors.length);

    // ---- A replayed settlement must not extend a second period ----
    const [before] = await sql<Array<{ current_period_end: string }>>`
      select current_period_end::text as current_period_end from subscriptions where user_id = ${paid.userId}
    `;
    const replay = await runCli(["--invoice", invoice.id, "--mark-paid"], env);
    assert.match(replay, /already settled/);
    const [after] = await sql<Array<{ current_period_end: string }>>`
      select current_period_end::text as current_period_end from subscriptions where user_id = ${paid.userId}
    `;
    assert.equal(after?.current_period_end, before?.current_period_end, "a duplicate mark-paid does not extend again");

    const [{ count: paymentEvents }] = await sql<Array<{ count: string }>>`
      select count(*)::text as count from billing_events where event_key = ${`invoice-paid:${invoice.id}`}
    `;
    assert.equal(Number(paymentEvents), 1, "exactly one payment event is recorded per invoice");

    // ---- Invalid operations are refused, and mutate nothing ----
    const cliFailsWith = (pattern: RegExp) => (error: unknown) => {
      const failure = error as { message?: string; stderr?: string };
      return pattern.test(`${failure.message ?? ""}\n${failure.stderr ?? ""}`);
    };
    await assert.rejects(() => runCli(["--invoice", "999999999", "--mark-paid"], env), cliFailsWith(/Unknown invoice/));
    await sql`update invoices set status = 'VOID' where id = ${invoice.id}`;
    await assert.rejects(
      () => runCli(["--invoice", invoice.id, "--mark-paid"], env),
      cliFailsWith(/Cannot mark a VOID invoice paid/)
    );

    // ---- A processor-managed subscription is still renewed by the sweep ----
    const processor = await authenticate(config);
    createdUsers.push(processor.userId);
    await runCli(["--user", processor.userId, "--plan", "pro"], env);
    await sql`
      update subscriptions
      set provider = 'stripe', provider_ref = 'sub_e2e_fixture',
          current_period_start = ${closedStart}::timestamptz,
          current_period_end = ${closedEnd}::timestamptz
      where user_id = ${processor.userId}
    `;
    const processorSweep = await runBillingLifecycle({ config, sql, logger: silentLogger() });
    assert.equal(processorSweep.renewed, 1, "a processor-managed subscription still auto-renews");
    assert.equal(processorSweep.expired, 0);
    const [processorRow] = await sql<Array<{ status: string; provider: string; current_period_end: string }>>`
      select status, provider, current_period_end::text as current_period_end
      from subscriptions where user_id = ${processor.userId}
    `;
    assert.equal(processorRow?.status, "ACTIVE");
    assert.equal(processorRow?.provider, "stripe", "the sweep must not relabel a processor-managed row");
    assert.ok(Date.parse(processorRow!.current_period_end) > Date.now(), "its period advanced");

    console.log("D11 revenue safety: manual renewal requires confirmed payment, settlement is idempotent, monitors are paused/restored, processor path unaffected: PASS");
  } finally {
    for (const id of createdUsers) {
      await sql`delete from privacy_monitors where user_id = ${id}`;
      await sql`delete from invoices where user_id = ${id}`;
      await sql`delete from billing_events where user_id = ${id}`;
      await sql`delete from subscriptions where user_id = ${id}`;
      await sql`delete from usage_records where user_id = ${id}`;
      await sql`delete from profiles where id = ${id}`;
    }
    for (const id of createdWallets) {
      await sql`delete from wallets where id = ${id}`;
    }
    await sql.end();
  }
}

function silentLogger(): AegixLogger {
  const noop = () => {};
  return { fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop, child: () => silentLogger() };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : "D11 revenue safety E2E failure");
  process.exitCode = 1;
});
