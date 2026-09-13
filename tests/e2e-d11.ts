import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { ed25519 } from "@noble/curves/ed25519";
import base58 from "bs58";
import { createDb, createBillingRepo, type Sql } from "@aegix/database";
import { loadConfig } from "@aegix/config";
import type { AegixLogger } from "@aegix/logging";
import { applyBillingAction, buildPlanCatalog, type BillingStore, type PlanCode } from "@aegix/billing";
import { assessFreshness, type MarketDataProvider } from "../packages/markets/src/index.js";
import { buildServer } from "../apps/api/src/server.js";
import { runBillingLifecycle } from "../apps/worker/src/processors/billing.js";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";

/**
 * D11 end-to-end: entitlement resolution against live enforcement points,
 * the lifecycle sweep, the ledger, and invoice generation.
 *
 * MARKETS_DAILY_QUOTA is deliberately tiny so the difference between a free
 * identity and a granted one shows up as a real 429 rather than as a number
 * in a response body.
 */

const MARKETS_FREE_QUOTA = 2;

async function authenticate(app: Awaited<ReturnType<typeof buildServer>>) {
  const key = ed25519.utils.randomPrivateKey();
  const address = base58.encode(ed25519.getPublicKey(key));
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
}

/** The operator grant path, exactly as scripts/grant-plan.ts performs it. */
function operatorStore(repo: ReturnType<typeof createBillingRepo>): BillingStore {
  return {
    async load(userId) {
      const row = await repo.getSubscription(userId);
      if (!row) return null;
      return {
        planCode: row.plan_code as PlanCode,
        status: row.status,
        currentPeriodStart: row.current_period_start,
        currentPeriodEnd: row.current_period_end,
        cancelAtPeriodEnd: row.cancel_at_period_end,
        gracePeriodEnd: row.grace_period_end,
        trialEnd: row.trial_end
      };
    },
    async save(input) {
      const result = await repo.applyTransition({
        userId: input.userId,
        subscription: {
          planCode: input.subscription.planCode,
          status: input.subscription.status,
          currentPeriodStart: input.subscription.currentPeriodStart,
          currentPeriodEnd: input.subscription.currentPeriodEnd,
          cancelAtPeriodEnd: input.subscription.cancelAtPeriodEnd,
          gracePeriodEnd: input.subscription.gracePeriodEnd,
          trialEnd: input.subscription.trialEnd,
          provider: "manual",
          providerRef: null
        },
        event: {
          eventType: input.event.type,
          fromStatus: input.event.fromStatus === "NONE" ? null : input.event.fromStatus,
          toStatus: input.event.toStatus,
          fromPlan: input.event.fromPlan,
          toPlan: input.event.toPlan,
          detail: { ...input.event.detail, grantedBy: "operator" },
          eventKey: input.eventKey,
          occurredAt: input.event.occurredAt
        },
        profilePlan: input.profilePlan
      });
      return result.applied;
    }
  };
}

async function cleanup(sql: Sql, userIds: string[]): Promise<void> {
  for (const id of userIds) {
    await sql`delete from billing_upgrade_requests where user_id = ${id}`;
    await sql`delete from privacy_monitors where user_id = ${id}`;
    await sql`delete from saved_analyses where user_id = ${id}`;
    await sql`delete from invoices where user_id = ${id}`;
    await sql`delete from billing_events where user_id = ${id}`;
    await sql`delete from subscriptions where user_id = ${id}`;
    await sql`delete from usage_records where user_id = ${id}`;
    await sql`delete from profiles where id = ${id}`;
  }
}

async function main(): Promise<void> {
  const safe = requireSafeTestDatabaseReset();
  // One free monitor (five on pro) so a lapsed plan's monitor pause is visible.
  const config = loadConfig({
    ...process.env,
    MARKETS_DAILY_QUOTA: String(MARKETS_FREE_QUOTA),
    BILLING_GRACE_DAYS: "7",
    MAX_ACTIVE_MONITORS_PER_USER: "1"
  });
  const sql = createDb(safe.databaseUrl);
  const repo = createBillingRepo(sql);
  const catalog = buildPlanCatalog(
    {
      analysisDaily: config.FREE_USER_DAILY_LIMIT,
      compareDaily: config.COMPARE_DAILY_USER_LIMIT,
      askDaily: config.ASK_AEGIX_DAILY_QUOTA,
      marketsDaily: config.MARKETS_DAILY_QUOTA,
      monitorsActive: config.MAX_ACTIVE_MONITORS_PER_USER,
      apiKeysActive: config.MAX_ACTIVE_API_KEYS_PER_USER,
      webhooksActive: config.MAX_ACTIVE_WEBHOOKS_PER_USER,
      apiDaily: config.DEVELOPER_DAILY_QUOTA
    },
    config.BILLING_CURRENCY
  );

  const now = new Date();
  const marketProvider: MarketDataProvider = {
    name: "e2e-d11-fixture",
    async getQuote(asset) {
      return {
        asset,
        priceUsd: 200,
        volume24hUsd: 1000,
        marketCapUsd: null,
        percentChange24h: null,
        provider: "e2e-d11-fixture",
        freshness: assessFreshness(now.toISOString(), now)
      };
    },
    async getHistory() {
      return Array.from({ length: 24 }, (_, i) => ({
        timestamp: new Date(now.getTime() - (23 - i) * 3600000).toISOString(),
        priceUsd: 100,
        volumeUsd: 100
      }));
    }
  };

  const app = await buildServer({ config, marketProvider });
  const created: string[] = [];

  try {
    // ---- The plan catalog is public and self-serve is off ----
    const plans = await app.inject({ url: "/v1/billing/plans" });
    assert.equal(plans.statusCode, 200);
    assert.deepEqual(plans.json().plans.map((p: { code: string }) => p.code), ["free", "pro", "team"]);
    assert.equal(plans.json().selfServe, false);

    // ---- A free identity is enforced at exactly the configured limits ----
    const free = await authenticate(app);
    created.push(free.userId);

    const freeSub = await app.inject({ url: "/v1/billing/subscription", headers: free.headers });
    assert.equal(freeSub.statusCode, 200);
    assert.equal(freeSub.json().plan.code, "free");
    assert.equal(freeSub.json().status, "NONE");
    assert.equal(freeSub.json().degraded, false);
    assert.equal(freeSub.json().entitlements["analysis.daily"], config.FREE_USER_DAILY_LIMIT);
    assert.equal(freeSub.json().entitlements["markets.daily"], MARKETS_FREE_QUOTA);

    // The entitlement is what the live enforcement point uses: the third
    // markets read of the day is refused.
    for (let i = 0; i < MARKETS_FREE_QUOTA; i++) {
      assert.equal((await app.inject({ url: "/v1/markets/SOL", headers: free.headers })).statusCode, 200, `markets call ${i + 1}`);
    }
    assert.equal((await app.inject({ url: "/v1/markets/SOL", headers: free.headers })).statusCode, 429);

    // ---- Self-serve upgrade is refused: V1 has no payment processor ----
    const upgrade = await app.inject({
      method: "POST",
      url: "/v1/billing/subscription/change",
      headers: free.headers,
      payload: { plan: "pro" }
    });
    assert.equal(upgrade.statusCode, 501);
    assert.equal(upgrade.json().code, "PAYMENT_PROVIDER_REQUIRED");

    // ---- V1 manual provisioning: a request records intent and grants nothing ----
    assert.equal((await app.inject({ method: "POST", url: "/v1/billing/upgrade-request", payload: { plan: "pro" } })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: "POST", url: "/v1/billing/upgrade-request", headers: free.headers, payload: { plan: "free" } })).statusCode,
      400,
      "the free plan is not something to request"
    );
    const requested = await app.inject({
      method: "POST",
      url: "/v1/billing/upgrade-request",
      headers: free.headers,
      payload: { plan: "pro", contact: "  @aegix-e2e  " }
    });
    assert.equal(requested.statusCode, 201, requested.body);
    assert.equal(requested.json().request.plan, "pro");
    const retargeted = await app.inject({ method: "POST", url: "/v1/billing/upgrade-request", headers: free.headers, payload: { plan: "team" } });
    assert.equal(retargeted.statusCode, 201);
    const [openRequests] = await sql<Array<{ count: string; plan: string | null; contact: string | null }>>`
      select count(*)::text as count, max(plan_code) as plan, max(contact) as contact
      from billing_upgrade_requests where user_id = ${free.userId} and status = 'OPEN'
    `;
    assert.equal(openRequests?.count, "1", "one open request per identity");
    assert.equal(openRequests?.plan, "team", "asking again re-targets the open request");
    assert.equal(openRequests?.contact, "@aegix-e2e", "a later request without a contact keeps the earlier one");
    const pending = await app.inject({ url: "/v1/billing/subscription", headers: free.headers });
    assert.equal(pending.json().plan.code, "free", "requesting an upgrade grants nothing");
    assert.equal(pending.json().status, "NONE");
    assert.equal(pending.json().upgradeRequest.plan, "team");
    assert.deepEqual((await app.inject({ url: "/v1/billing/events", headers: free.headers })).json().events, [], "a request writes no ledger entry");
    assert.equal((await app.inject({ url: "/v1/markets/SOL", headers: free.headers })).statusCode, 429, "free limits still apply while pending");

    // ---- The operator grants it with the supported CLI; the request closes ----
    const cli = execFileSync(process.execPath, ["--import", "tsx", "scripts/grant-plan.ts", "--user", free.userId, "--plan", "team"], {
      env: { ...process.env, DATABASE_URL: safe.databaseUrl },
      encoding: "utf8"
    });
    assert.match(cli, /SUBSCRIPTION_CREATED: free → team \(ACTIVE\)/);
    assert.match(cli, /upgrade request fulfilled/);
    // A fresh server: this identity's plan is cached on the first one, and an
    // out-of-band grant is otherwise visible only after the 30s cache TTL.
    const grantedApp = await buildServer({ config, marketProvider });
    try {
      const teamSub = await grantedApp.inject({ url: "/v1/billing/subscription", headers: free.headers });
      assert.equal(teamSub.json().plan.code, "team");
      assert.equal(teamSub.json().status, "ACTIVE");
      assert.equal(teamSub.json().upgradeRequest, null, "a granted plan closes the request");
      assert.equal(teamSub.json().entitlements["markets.daily"], MARKETS_FREE_QUOTA * 40);
      assert.equal(
        (await grantedApp.inject({ url: "/v1/markets/SOL", headers: free.headers })).statusCode,
        200,
        "the granted plan lifts the quota the request could not"
      );
      const onPlan = await grantedApp.inject({ method: "POST", url: "/v1/billing/upgrade-request", headers: free.headers, payload: { plan: "pro" } });
      assert.equal(onPlan.statusCode, 409, "a plan already covered is not requested");
    } finally {
      await grantedApp.close();
    }

    // ---- An operator grant raises the same enforcement point ----
    // Granted before the first request so the entitlement cache is cold; a
    // grant made out of band is otherwise visible only after its 30s TTL.
    const paid = await authenticate(app);
    created.push(paid.userId);
    const granted = await applyBillingAction(operatorStore(repo), catalog, {
      userId: paid.userId,
      action: "SUBSCRIBE",
      planCode: "pro",
      now: new Date(),
      graceDays: config.BILLING_GRACE_DAYS
    });
    assert.equal(granted.applied, true);
    assert.equal(granted.subscription.status, "ACTIVE");

    const paidSub = await app.inject({ url: "/v1/billing/subscription", headers: paid.headers });
    assert.equal(paidSub.json().plan.code, "pro");
    assert.equal(paidSub.json().status, "ACTIVE");
    assert.equal(paidSub.json().entitlements["markets.daily"], MARKETS_FREE_QUOTA * 10);

    for (let i = 0; i < MARKETS_FREE_QUOTA + 1; i++) {
      assert.equal((await app.inject({ url: "/v1/markets/SOL", headers: paid.headers })).statusCode, 200, `paid markets call ${i + 1}`);
    }

    // ---- Usage reporting reflects what was actually metered ----
    const usage = await app.inject({ url: "/v1/billing/usage", headers: paid.headers });
    assert.equal(usage.statusCode, 200);
    const markets = usage.json().dimensions.find((d: { dimension: string }) => d.dimension === "MARKETS");
    assert.equal(markets.units, MARKETS_FREE_QUOTA + 1);
    assert.equal(markets.entitlementKey, "markets.daily");
    assert.equal(markets.overageUnits, 0);

    // ---- Cancel schedules, resume revokes, and both reach the ledger ----
    const cancel = await app.inject({ method: "POST", url: "/v1/billing/subscription/cancel", headers: paid.headers, payload: {} });
    assert.equal(cancel.statusCode, 200);
    assert.equal(cancel.json().status, "CANCELED");
    assert.equal(cancel.json().cancelAtPeriodEnd, true);
    // The paid period is still honoured after cancellation is scheduled.
    assert.equal((await app.inject({ url: "/v1/billing/subscription", headers: paid.headers })).json().plan.code, "pro");

    const resume = await app.inject({ method: "POST", url: "/v1/billing/subscription/resume", headers: paid.headers });
    assert.equal(resume.statusCode, 200);
    assert.equal(resume.json().status, "ACTIVE");

    // A second resume is a state error, not a silent success.
    assert.equal((await app.inject({ method: "POST", url: "/v1/billing/subscription/resume", headers: paid.headers })).statusCode, 409);

    const events = await app.inject({ url: "/v1/billing/events", headers: paid.headers });
    assert.deepEqual(
      events.json().events.map((e: { event_type: string }) => e.event_type),
      ["CANCELLATION_REVOKED", "CANCELLATION_SCHEDULED", "SUBSCRIPTION_CREATED"]
    );

    // ---- Billing state is per identity: another user sees, changes and spends only their own ----
    const other = await authenticate(app);
    created.push(other.userId);
    const otherSub = await app.inject({ url: "/v1/billing/subscription", headers: other.headers });
    assert.equal(otherSub.json().plan.code, "free", "another identity does not inherit a paid plan");
    assert.equal(otherSub.json().status, "NONE");
    assert.deepEqual((await app.inject({ url: "/v1/billing/events", headers: other.headers })).json().events, [], "no foreign ledger entries");
    const otherCancel = await app.inject({ method: "POST", url: "/v1/billing/subscription/cancel", headers: other.headers, payload: {} });
    assert.ok(otherCancel.statusCode >= 400, `cancelling without a subscription is refused (${otherCancel.statusCode})`);
    assert.equal(
      (await app.inject({ url: "/v1/billing/subscription", headers: paid.headers })).json().status,
      "ACTIVE",
      "another identity cannot touch this subscription"
    );
    for (let i = 0; i < MARKETS_FREE_QUOTA; i++) {
      assert.equal((await app.inject({ url: "/v1/markets/SOL", headers: other.headers })).statusCode, 200, `other markets call ${i + 1}`);
    }
    assert.equal((await app.inject({ url: "/v1/markets/SOL", headers: other.headers })).statusCode, 429, "quota is not shared with a paid identity");
    assert.equal((await app.inject({ url: "/v1/billing/subscription" })).statusCode, 401, "billing state requires a session");

    // ---- The lifecycle sweep renews an elapsed period and invoices it ----
    const closedStart = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const closedEnd = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await sql`
      update subscriptions
      set current_period_start = ${closedStart}::timestamptz,
          current_period_end = ${closedEnd}::timestamptz
      where user_id = ${paid.userId}
    `;

    const swept = await runBillingLifecycle({ config, sql, logger: silentLogger() });
    assert.equal(swept.renewed, 1, "the elapsed period is renewed");
    assert.equal(swept.invoiced, 1, "the closed period is invoiced");

    // Running again changes nothing: the row is no longer due, and the
    // deterministic event key would absorb it even if it were.
    const again = await runBillingLifecycle({ config, sql, logger: silentLogger() });
    assert.equal(again.renewed, 0);
    assert.equal(again.scanned, 0);

    const invoices = await repo.listInvoices(paid.userId, 10);
    assert.equal(invoices.length, 1, "one invoice per period, not one per sweep");
    assert.equal(invoices[0]?.plan_code, "pro");
    assert.equal(invoices[0]?.total_cents, 4900);
    assert.equal(invoices[0]?.status, "OPEN", "nothing can be settled without a payment provider");
    assert.equal(invoices[0]?.period_start, closedStart);
    const invoiceId = invoices[0]?.id;
    assert.equal((await app.inject({ url: `/v1/billing/invoices/${invoiceId}`, headers: paid.headers })).statusCode, 200);
    assert.equal(
      (await app.inject({ url: `/v1/billing/invoices/${invoiceId}`, headers: other.headers })).statusCode,
      404,
      "another identity cannot read this invoice"
    );

    // ---- A closed grace window degrades to free without losing the row ----
    await sql`
      update subscriptions
      set status = 'PAST_DUE', grace_period_end = ${new Date(Date.now() - 86_400_000).toISOString()}::timestamptz
      where user_id = ${paid.userId}
    `;
    // Force a fresh resolution rather than waiting out the cache TTL.
    const degradedApp = await buildServer({ config, marketProvider });
    try {
      const fresh = await degradedApp.inject({ url: "/v1/billing/subscription", headers: paid.headers });
      assert.equal(fresh.json().plan.code, "free", "entitlements degrade once the grace window closes");
      assert.equal(fresh.json().subscribedPlan.code, "pro", "the subscription itself is not deleted");
      assert.equal(fresh.json().degraded, true);

      const expired = await runBillingLifecycle({ config, sql, logger: silentLogger() });
      assert.equal(expired.expired, 1);
      const [row] = await sql<Array<{ status: string; plan: string }>>`
        select s.status, p.plan
        from subscriptions s join profiles p on p.id = s.user_id
        where s.user_id = ${paid.userId}
      `;
      assert.equal(row?.status, "EXPIRED");
      assert.equal(row?.plan, "free", "profiles.plan follows the subscription it describes");
    } finally {
      await degradedApp.close();
    }

    // ---- A lapsed plan pauses the monitors it no longer covers, and never deletes them ----
    const watcher = await authenticate(app);
    created.push(watcher.userId);
    const watcherGrant = await applyBillingAction(operatorStore(repo), catalog, {
      userId: watcher.userId,
      action: "SUBSCRIBE",
      planCode: "pro",
      now: new Date(),
      graceDays: config.BILLING_GRACE_DAYS
    });
    assert.equal(watcherGrant.applied, true);

    const monitorIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const address = base58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
      assert.equal((await app.inject({ method: "POST", url: "/v1/me/saved", headers: watcher.headers, payload: { address } })).statusCode, 201);
      const createdMonitor = await app.inject({ method: "POST", url: "/v1/me/monitors", headers: watcher.headers, payload: { address } });
      assert.equal(createdMonitor.statusCode, 201, `pro covers monitor ${i + 1}: ${createdMonitor.body}`);
      monitorIds.push(String(createdMonitor.json().monitor.id));
      // Distinct creation instants keep the oldest-first order unambiguous.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The owner pauses the newest one: the plan must never resume it.
    const ownerPause = await app.inject({ method: "PATCH", url: `/v1/me/monitors/${monitorIds[3]}`, headers: watcher.headers, payload: { status: "PAUSED" } });
    assert.equal(ownerPause.statusCode, 200);

    const monitorStatuses = async () =>
      (await sql<Array<{ status: string }>>`
        select status from privacy_monitors where user_id = ${watcher.userId} order by created_at asc, id asc
      `).map((row) => row.status);
    assert.deepEqual(await monitorStatuses(), ["ACTIVE", "ACTIVE", "ACTIVE", "PAUSED"]);

    // The plan lapses (the state the sweep and resolver both treat as free).
    await sql`update subscriptions set status = 'EXPIRED' where user_id = ${watcher.userId}`;
    const lapsedSweep = await runBillingLifecycle({ config, sql, logger: silentLogger() });
    assert.ok(lapsedSweep.monitorsPaused >= 2, `the sweep paused the uncovered monitors (${lapsedSweep.monitorsPaused})`);
    assert.deepEqual(
      await monitorStatuses(),
      ["ACTIVE", "ENTITLEMENT_PAUSED", "ENTITLEMENT_PAUSED", "PAUSED"],
      "the oldest monitor keeps running; the newest uncovered ones pause; the owner's pause is untouched"
    );
    const [kept] = await sql<Array<{ monitors: string; saved: string }>>`
      select
        (select count(*)::text from privacy_monitors where user_id = ${watcher.userId}) as monitors,
        (select count(*)::text from saved_analyses where user_id = ${watcher.userId}) as saved
    `;
    assert.equal(kept?.monitors, "4", "no monitor is deleted when the plan lapses");
    assert.equal(kept?.saved, "4", "no saved analysis is deleted when the plan lapses");

    // Resuming by hand is held to the free limit, like creating one.
    const lapsedApp = await buildServer({ config, marketProvider });
    try {
      const resumeByHand = await lapsedApp.inject({ method: "PATCH", url: `/v1/me/monitors/${monitorIds[1]}`, headers: watcher.headers, payload: { status: "ACTIVE" } });
      assert.equal(resumeByHand.statusCode, 429);
      assert.equal(resumeByHand.json().code, "MONITOR_LIMIT_REACHED");
      const lapsedList = await lapsedApp.inject({ url: "/v1/me/monitors", headers: watcher.headers });
      assert.equal(lapsedList.statusCode, 200);
      assert.equal(lapsedList.json().monitors.length, 4, "paused monitors stay visible to their owner");
    } finally {
      await lapsedApp.close();
    }

    // The plan returns: the sweep resumes the monitors it paused, and only those.
    await sql`update subscriptions set status = 'ACTIVE' where user_id = ${watcher.userId}`;
    const restoredSweep = await runBillingLifecycle({ config, sql, logger: silentLogger() });
    assert.ok(restoredSweep.monitorsResumed >= 2, `the sweep resumed the covered monitors (${restoredSweep.monitorsResumed})`);
    assert.deepEqual(await monitorStatuses(), ["ACTIVE", "ACTIVE", "ACTIVE", "PAUSED"]);
    await runBillingLifecycle({ config, sql, logger: silentLogger() });
    assert.deepEqual(await monitorStatuses(), ["ACTIVE", "ACTIVE", "ACTIVE", "PAUSED"], "a repeated sweep changes nothing");

    console.log("D11 entitlement enforcement, cross-user isolation, ledger, lifecycle sweep, invoicing and monitor entitlement: PASS");
  } finally {
    await app.close();
    await cleanup(sql, created);
    await sql.end();
  }
}

function silentLogger(): AegixLogger {
  const noop = () => {};
  return { fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop, child: () => silentLogger() };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : "D11 E2E failure");
  process.exitCode = 1;
});
