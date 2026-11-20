import type { FastifyInstance } from "fastify";
import type { Sql } from "@aegix/database";
import type { AppConfig } from "@aegix/config";
import { CHAINS, createNetworkQuery, createReputationStore, parseChain, walletIdentity, readReputationPolicy } from "@aegix/network";
import { requireUser } from "./auth.js";
import { developerError, developerSuccess } from "./developer-api.js";
import type { DeveloperIntelligenceDeps } from "./developer-intelligence.js";

export function registerNetwork(deps: Pick<DeveloperIntelligenceDeps, "app" | "sql" | "config" | "developerAuth" | "recordUsage">) {
  const { app, sql, config, developerAuth, recordUsage } = deps;
  const query = createNetworkQuery(sql);
  const walletParams = { type: "object", required: ["chain", "address"], additionalProperties: false,
    properties: { chain: { type: "string", enum: ["solana:mainnet", "eip155:1", "eip155:8453"] }, address: { type: "string", minLength: 32, maxLength: 44 } } };
  const historyQuery = { type: "object", additionalProperties: false, properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 }, beforeHeight: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    beforePosition: { type: "integer", minimum: 0, maximum: 1000000 }
  }, dependencies: { beforeHeight: ["beforePosition"], beforePosition: ["beforeHeight"] } };
  // Transfers page by (height, position, ordinal); -1 is a transaction's native amount.
  const transferQuery = { ...historyQuery, properties: { ...historyQuery.properties,
    beforeOrdinal: { type: "integer", minimum: -1, maximum: 1000000 } },
  dependencies: { beforeHeight: ["beforePosition", "beforeOrdinal"], beforePosition: ["beforeHeight"], beforeOrdinal: ["beforeHeight"] } };

  // Same read service for session-based product users and metered developers.
  for (const developer of [false, true]) {
    const prefix = developer ? "/v1/developer/network" : "/v1/network";
    for (const kind of ["status", "history", "transfers", "reputation"] as const) {
      const url = kind === "status" ? `${prefix}/status` : `${prefix}/${kind}/:chain/:address`;
      app.get<{ Params: { chain: string; address: string }; Querystring: { limit?: number; beforeHeight?: number; beforePosition?: number; beforeOrdinal?: number } }>(url,
        { config: { rateLimit: { max: config.DEVELOPER_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } },
          schema: kind === "status" ? {} : { params: walletParams,
            ...(kind === "history" ? { querystring: historyQuery } : kind === "transfers" ? { querystring: transferQuery } : {}) } },
        async (req, reply) => {
          const requestId = req.id;
          reply.header("cache-control", "no-store");
          if (!config.ENABLE_NETWORK_API || (developer && !config.ENABLE_DEVELOPER_API)) return developerError(reply, "FEATURE_DISABLED", "Network intelligence is disabled", 403, requestId);
          const identity = developer ? await developerAuth.requireScope(req, reply, "intelligence:read") : null;
          if (developer && !identity) return;
          if (!developer) {
            const user = await requireUser(req, reply);
            if (!user || user.isAnonymous) return;
          }
          let chain: ReturnType<typeof parseChain> | undefined;
          if (kind !== "status") {
            try { chain = parseChain(req.params.chain); walletIdentity(chain, req.params.address); }
            catch { return developerError(reply, "INVALID_REQUEST", "Invalid chain or address", 400, requestId); }
            if (kind === "transfers" && CHAINS[chain!].family !== "evm") {
              return developerError(reply, "INVALID_REQUEST", "Transfers are recorded for EVM chains only", 400, requestId);
            }
          }
          if (identity) {
            const quota = await developerAuth.checkAndClaimQuota(identity, { units: 1 });
            if (!quota.allowed) return developerError(reply, "QUOTA_EXCEEDED", "Daily developer quota exceeded", 429, requestId);
          }
          try {
            const data = kind === "status" ? await query.status() : kind === "history"
              ? await query.history(chain!, req.params.address, req.query.limit ?? 50,
                req.query.beforeHeight === undefined ? undefined : { height: req.query.beforeHeight, position: req.query.beforePosition! })
              : kind === "transfers"
              ? await query.transfers(chain!, req.params.address, req.query.limit ?? 50,
                req.query.beforeHeight === undefined ? undefined
                  : { height: req.query.beforeHeight, position: req.query.beforePosition!, ordinal: req.query.beforeOrdinal! })
              : config.REPUTATION_POLICY_FILE
                ? await createReputationStore(sql, await readReputationPolicy(config.REPUTATION_POLICY_FILE)).report(chain!, req.params.address)
                : { wallet: walletIdentity(chain!, req.params.address), status: "NOT_CONFIGURED", score: null, riskBand: null,
                  accepted: [], rejected: [], reason: "No reviewed production dataset is configured." };
            if (identity) await recordUsage({ developer: identity, requestId, operation: `network.${kind}`, status: "SUCCESS", units: 1 });
            return developerSuccess(reply, data, requestId);
          } catch {
            return developerError(reply, "SERVICE_BUSY", "Network data is temporarily unavailable", 503, requestId);
          }
        });
    }
  }
  registerEconomicRead(app, sql, config);
}

function registerEconomicRead(app: FastifyInstance, sql: Sql, config: AppConfig) {
  app.get("/v1/me/aex", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!config.ENABLE_NETWORK_API) return reply.code(403).send({ code: "FEATURE_DISABLED" });
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    // Account IDs come only from verified sessions, never from request parameters.
    const id = `user:${user.id}`;
    const [account] = await sql`select balance::text from aex_accounts where id = ${id}`;
    const events = await sql`select event_key, amount::text, purpose, created_at,
      case when debit_account = ${id} then 'DEBIT' else 'CREDIT' end as direction
      from aex_transfers where debit_account = ${id} or credit_account = ${id}
      order by created_at desc, event_key desc limit 50`;
    return reply.send({ mode: "INTERNAL_ACCOUNTING", tokenLive: false, balanceAtomic: account?.balance ?? "0", events,
      explanation: "Internal accounting units; not an on-chain $AGX balance. Nothing moves between this ledger and the $AGX mint." });
  });
}
