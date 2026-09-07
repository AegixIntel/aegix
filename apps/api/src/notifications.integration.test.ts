import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "@aegix/config";
import { createDb } from "@aegix/database";
import { buildServer } from "./server.js";
import { encodeNotificationCursor } from "./notification-cursor.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/aegix_test";

test("in-app notification API validates, paginates stably, and isolates mutations", async () => {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    EMAIL_ENABLED: "false",
    ENABLE_EMAIL_NOTIFICATIONS: "false"
  });
  const sql = createDb(databaseUrl);
  const app = await buildServer({ config });
  const userA = randomUUID();
  const userB = randomUUID();
  const token = `notification-test-${randomUUID()}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const auth = { authorization: `Bearer ${token}` };

  try {
    await sql`insert into profiles (id, primary_wallet) values (${userA}, ${`wallet-${userA}`}), (${userB}, ${`wallet-${userB}`})`;
    await sql`insert into sessions (user_id, token_hash, expires_at) values (${userA}, ${tokenHash}, ${new Date(Date.now() + 60_000).toISOString()})`;
    const createdAt = "2026-09-06T10:00:00.000Z";
    const ids: string[] = [];
    for (const severity of ["HIGH", "LOW", "INFO"] as const) {
      const [row] = await sql<Array<{ id: string }>>`
        insert into notifications (user_id, channel, type, title, body, severity, status, idempotency_key, created_at)
        values (${userA}, 'IN_APP', 'TEST', ${severity}, 'body', ${severity}, 'SENT', ${randomUUID()}, ${createdAt})
        returning id
      `;
      ids.push(String(row!.id));
    }
    const [emailRow] = await sql<Array<{ id: string }>>`
      insert into notifications (user_id, channel, type, title, body, severity, status, idempotency_key, created_at)
      values (${userA}, 'EMAIL', 'TEST', 'dormant', 'body', 'HIGH', 'PENDING', ${randomUUID()}, ${createdAt}) returning id
    `;
    const [other] = await sql<Array<{ id: string }>>`
      insert into notifications (user_id, channel, type, title, body, severity, status, idempotency_key, created_at)
      values (${userB}, 'IN_APP', 'TEST', 'other', 'body', 'HIGH', 'SENT', ${randomUUID()}, ${createdAt}) returning id
    `;

    for (const url of [
      "/v1/me/notifications?limit=0",
      "/v1/me/notifications?limit=101",
      "/v1/me/notifications?limit=nope",
      "/v1/me/notifications?severity=URGENT",
      "/v1/me/notifications?channel=EMAIL",
      "/v1/me/notifications?unread=maybe",
      "/v1/me/notifications?cursor=invalid"
    ]) {
      const response = await app.inject({ method: "GET", url, headers: auth });
      assert.equal(response.statusCode, 400, url);
      assert.equal(response.json().error.code, "INVALID_REQUEST", url);
    }
    assert.equal((await app.inject({ method: "GET", url: "/v1/me/notifications" })).statusCode, 401);

    const first = await app.inject({ method: "GET", url: "/v1/me/notifications?limit=2", headers: auth });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json().notifications.map((n: { id: string }) => String(n.id)), [...ids].reverse().slice(0, 2));
    assert.ok(first.json().nextCursor);

    // A notification arriving after page 1 belongs ahead of that page. It
    // must not duplicate or displace older rows when the original cursor is
    // used, and it must appear on a fresh first-page request.
    const [newArrival] = await sql<Array<{ id: string }>>`
      insert into notifications (user_id, channel, type, title, body, severity, status, idempotency_key, created_at)
      values (${userA}, 'IN_APP', 'TEST', 'new arrival', 'body', 'HIGH', 'SENT', ${randomUUID()}, ${"2026-09-06T10:00:01.000Z"})
      returning id
    `;
    const second = await app.inject({ method: "GET", url: `/v1/me/notifications?limit=2&cursor=${first.json().nextCursor}`, headers: auth });
    assert.deepEqual(second.json().notifications.map((n: { id: string }) => String(n.id)), [ids[0]]);
    const refreshed = await app.inject({ method: "GET", url: "/v1/me/notifications?limit=2", headers: auth });
    assert.equal(String(refreshed.json().notifications[0].id), String(newArrival!.id));

    const foreignCursor = encodeNotificationCursor({ createdAt, id: String(other!.id) });
    const foreignPage = await app.inject({ method: "GET", url: `/v1/me/notifications?cursor=${foreignCursor}`, headers: auth });
    assert.equal(foreignPage.statusCode, 200);
    assert.ok(foreignPage.json().notifications.every((n: { user_id: string }) => n.user_id === userA));

    const markOne = await app.inject({ method: "POST", url: `/v1/me/notifications/${ids[2]}/read`, headers: auth });
    assert.equal(markOne.statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `/v1/me/notifications/${ids[2]}/read`, headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `/v1/me/notifications/${other!.id}/read`, headers: auth })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/v1/me/notifications/${emailRow!.id}/read`, headers: auth })).statusCode, 404);

    const unread = await app.inject({ method: "GET", url: "/v1/me/notifications?unread=true&severity=LOW", headers: auth });
    assert.equal(unread.statusCode, 200);
    assert.deepEqual(unread.json().notifications.map((n: { id: string }) => String(n.id)), [ids[1]]);

    const markAll = await app.inject({ method: "POST", url: "/v1/me/notifications/read-all", headers: auth });
    assert.equal(markAll.statusCode, 200);
    assert.equal(markAll.json().marked, 3);
    const [emailState] = await sql<Array<{ read_at: string | null }>>`select read_at from notifications where id = ${emailRow!.id}`;
    const [otherState] = await sql<Array<{ read_at: string | null }>>`select read_at from notifications where id = ${other!.id}`;
    assert.equal(emailState!.read_at, null);
    assert.equal(otherState!.read_at, null);
  } finally {
    await app.close();
    await sql`delete from profiles where id in (${userA}, ${userB})`;
    await sql.end();
  }
});
