/**
 * Webhook management routes (D6-H §124), see docs/d6-block2.md.
 *
 * Product-session authenticated (wallet login). Ownership is enforced per
 * user. Secrets are encrypted at rest and shown exactly once.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "@aegix/config";
import type { Sql } from "@aegix/database";
import { createWebhookRepo, WEBHOOK_EVENT_TYPES, type WebhookEventType } from "@aegix/database";
import type { AegixLogger } from "@aegix/logging";
import type { AuthUser } from "./auth.js";
import { createWebhookSecret, WebhookSecretError } from "./webhook-crypto.js";

export interface WebhookRoutesDeps {
  app: FastifyInstance;
  sql: Sql;
  config: AppConfig;
  logger: AegixLogger;
  requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<AuthUser | null>;
  /** Active-endpoint ceiling for this identity (D11 `webhooks.active`). */
  activeWebhookLimit: (userId: string) => Promise<number>;
}

/** URL validation: http(s) only, no credentials, no fragments. */
export function validateWebhookUrl(url: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "Only http(s) webhook URLs are allowed" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "URL credentials are not allowed" };
  }
  if (parsed.hash) {
    return { ok: false, reason: "URL fragments are not allowed" };
  }
  return { ok: true };
}

export function registerWebhookRoutes(deps: WebhookRoutesDeps): void {
  const { app, sql, config, logger, requireUser } = deps;
  const webhookRepo = createWebhookRepo(sql);

  const gate = (reply: FastifyReply): boolean => {
    if (!config.ENABLE_WEBHOOK_DELIVERY) {
      reply.code(403).send({ error: { code: "FEATURE_DISABLED", message: "Webhooks are currently disabled" }, meta: { requestId: randomUUID() } });
      return true;
    }
    return false;
  };

  // POST /v1/webhooks — create (secret shown once).
  app.post<{ Body: { url: string; eventTypes?: string[] } }>(
    "/v1/webhooks",
    {
      schema: {
        body: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", minLength: 8, maxLength: 2048 },
            eventTypes: { type: "array", items: { type: "string" }, maxItems: 8 }
          }
        }
      }
    },
    async (req, reply) => {
      if (gate(reply)) return;
      const user = await requireUser(req, reply);
      if (!user || user.isAnonymous) return;
      const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();

      const url = req.body.url.trim();
      const validation = validateWebhookUrl(url);
      if (!validation.ok) {
        return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: validation.reason }, meta: { requestId } });
      }
      const rawTypes = req.body.eventTypes?.length ? req.body.eventTypes : [...WEBHOOK_EVENT_TYPES];
      const unknown = rawTypes.filter((t) => !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(t));
      if (unknown.length > 0) {
        return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: `Unknown event type(s): ${unknown.join(", ")}` }, meta: { requestId } });
      }
      const eventTypes = [...new Set(rawTypes)] as WebhookEventType[];

      // D11: webhook endpoints are a plan-controlled concurrent level.
      // Before D11 this resource was unbounded per identity.
      const webhookLimit = await deps.activeWebhookLimit(user.id);
      const activeWebhooks = await webhookRepo.countActiveForUser(user.id);
      if (activeWebhooks >= webhookLimit) {
        return reply.code(429).send({
          error: { code: "WEBHOOK_LIMIT_REACHED", message: `Active webhook limit reached (${webhookLimit})` },
          meta: { requestId }
        });
      }

      let material;
      try {
        material = createWebhookSecret(config);
      } catch (err) {
        logger.error("webhook secret creation failed", { error: err instanceof Error ? err.message : String(err) });
        return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Webhook encryption is not configured" }, meta: { requestId } });
      }

      const row = await webhookRepo.create({
        userId: user.id,
        url,
        eventTypes,
        secretEncrypted: material.encrypted,
        secretNonce: material.nonce,
        secretKeyVersion: material.keyVersion
      });

      logger.info("webhook created", { requestId, webhookId: row.id, hostSafe: hostForLog(url) });
      return reply.code(201).send({
        data: {
          webhook: {
            id: row.id,
            url: row.url,
            status: row.status,
            eventTypes,
            createdAt: row.created_at
          },
          // Shown exactly once (D6-H §101).
          secret: material.secret
        },
        meta: { requestId }
      });
    }
  );

  // GET /v1/webhooks — list.
  app.get("/v1/webhooks", async (req, reply) => {
    if (gate(reply)) return;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
    const rows = await webhookRepo.listForUser(user.id);
    return reply.send({
      data: rows.map((r) => ({
        id: r.id,
        url: r.url,
        status: r.status,
        eventTypes: r.event_types,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastSuccessAt: r.last_success_at,
        lastFailureAt: r.last_failure_at,
        failureCount: r.failure_count,
        disabledAt: r.disabled_at,
        disabledReason: r.disabled_reason
      })),
      meta: { requestId }
    });
  });

  // GET /v1/webhooks/:id — detail.
  app.get<{ Params: { id: string } }>("/v1/webhooks/:id", async (req, reply) => {
    if (gate(reply)) return;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
    const row = await webhookRepo.getForUser(user.id, req.params.id);
    if (!row) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Webhook not found" }, meta: { requestId } });
    }
    return reply.send({ data: { id: row.id, url: row.url, status: row.status, eventTypes: row.event_types, createdAt: row.created_at, updatedAt: row.updated_at, lastSuccessAt: row.last_success_at, lastFailureAt: row.last_failure_at, failureCount: row.failure_count, disabledAt: row.disabled_at, disabledReason: row.disabled_reason }, meta: { requestId } });
  });

  // PATCH /v1/webhooks/:id — url / event types / status (disable/re-enable).
  app.patch<{ Params: { id: string }; Body: { url?: string; eventTypes?: string[]; status?: string } }>(
    "/v1/webhooks/:id",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            url: { type: "string", minLength: 8, maxLength: 2048 },
            eventTypes: { type: "array", items: { type: "string" }, maxItems: 8 },
            status: { type: "string", enum: ["ACTIVE", "DISABLED"] }
          }
        }
      }
    },
    async (req, reply) => {
      if (gate(reply)) return;
      const user = await requireUser(req, reply);
      if (!user || user.isAnonymous) return;
      const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();

      const patch: { url?: string; eventTypes?: WebhookEventType[]; status?: "ACTIVE" | "DISABLED"; disabledReason?: string | null } = {};
      if (req.body.url !== undefined) {
        const validation = validateWebhookUrl(req.body.url.trim());
        if (!validation.ok) {
          return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: validation.reason }, meta: { requestId } });
        }
        patch.url = req.body.url.trim();
      }
      if (req.body.eventTypes !== undefined) {
        const unknown = req.body.eventTypes.filter((t) => !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(t));
        if (unknown.length > 0) {
          return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: `Unknown event type(s): ${unknown.join(", ")}` }, meta: { requestId } });
        }
        patch.eventTypes = [...new Set(req.body.eventTypes)] as WebhookEventType[];
      }
      if (req.body.status !== undefined) {
        patch.status = req.body.status as "ACTIVE" | "DISABLED";
        patch.disabledReason = req.body.status === "DISABLED" ? "user disabled" : null;
      }

      const updated = await webhookRepo.updateForUser(user.id, req.params.id, patch);
      if (!updated) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Webhook not found" }, meta: { requestId } });
      }
      logger.info("webhook updated", { requestId, webhookId: updated.id, status: updated.status });
      return reply.send({ data: { id: updated.id, url: updated.url, status: updated.status, eventTypes: updated.event_types }, meta: { requestId } });
    }
  );

  // POST /v1/webhooks/:id/rotate — new secret (shown once).
  app.post<{ Params: { id: string } }>("/v1/webhooks/:id/rotate", async (req, reply) => {
    if (gate(reply)) return;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
    let material;
    try {
      material = createWebhookSecret(config);
    } catch {
      return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Webhook encryption is not configured" }, meta: { requestId } });
    }
    const row = await webhookRepo.rotateSecret(user.id, req.params.id, {
      secretEncrypted: material.encrypted,
      secretNonce: material.nonce,
      secretKeyVersion: material.keyVersion
    });
    if (!row) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Webhook not found" }, meta: { requestId } });
    }
    logger.info("webhook secret rotated", { requestId, webhookId: row.id });
    return reply.send({ data: { id: row.id, secret: material.secret }, meta: { requestId } });
  });

  // DELETE /v1/webhooks/:id
  app.delete<{ Params: { id: string } }>("/v1/webhooks/:id", async (req, reply) => {
    if (gate(reply)) return;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
    const deleted = await webhookRepo.deleteForUser(user.id, req.params.id);
    if (!deleted) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Webhook not found" }, meta: { requestId } });
    }
    logger.info("webhook deleted", { requestId, webhookId: req.params.id });
    return reply.send({ data: { deleted: true }, meta: { requestId } });
  });

  // POST /v1/webhooks/:id/test — SSRF-protected test delivery (§125).
  app.post<{ Params: { id: string } }>("/v1/webhooks/:id/test", async (req, reply) => {
    if (gate(reply)) return;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
    const row = await webhookRepo.getForUser(user.id, req.params.id);
    if (!row) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Webhook not found" }, meta: { requestId } });
    }
    try {
      const { enqueueWebhookDelivery } = await import("@aegix/webhook-delivery");
      const queues = (await import("@aegix/queue")).createQueues(config);
      try {
        await enqueueWebhookDelivery({ sql, config, logger, queues }, {
          eventType: "monitor.threat.created",
          payload: { id: `test-${randomUUID()}`, type: "monitor.threat.created", createdAt: new Date().toISOString(), data: { test: true, message: "This is a test delivery." } }
        });
      } finally {
        await queues.close().catch(() => {});
      }
      return reply.send({ data: { queued: true }, meta: { requestId } });
    } catch {
      return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Failed to queue test delivery" }, meta: { requestId } });
    }
  });
}

function hostForLog(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

export type { WebhookSecretError };
