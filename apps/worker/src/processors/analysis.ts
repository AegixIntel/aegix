import type { Job } from "bullmq";
import type { AppConfig } from "@aegix/config";
import type { BlockchainProvider } from "@aegix/blockchain";
import { createProviderPoolFromConfig, ProviderPool } from "@aegix/blockchain";
import {
  createAnalysisJobRepo,
  createDb,
  createEntityRegistryRepo,
  createIntelligenceRepo,
  createWalletAnalyticsRepo,
  createWalletRepo,
  type EntityAddressSeedRow,
  type EntitySeedRow
} from "@aegix/database";
import { normalizeTransaction, type ParsedTransactionLike } from "@aegix/normalizer";
import type { IntelligenceSignal, NormalizedTransaction, WalletRelationship } from "@aegix/types";
import {
  analyzeBehavior,
  analyzeClusters,
  analyzeCounterparties,
  analyzeEntities,
  analyzeFunding,
  type EntityRegistry
} from "@aegix/intelligence";
import { computeDataQuality, scoreWallet, type ScoreResult } from "@aegix/scoring";
import { annotateEntities, buildGraph, findExposurePaths } from "@aegix/graph";
import { explainPath, explainSignal } from "@aegix/explanation";
import type { AnalysisJobData } from "@aegix/queue";
import type { ProcessorContext } from "../worker.js";

const PIPELINE_VERSION = "aegix-pipeline-v1.0.0";

interface FetchStats {
  signaturesFetched: number;
  transactionsReceived: number;
  transactionsParsed: number;
  parserFailures: number;
  rpcFailures: number;
  unknownProgramCount: number;
  historyStart: string | null;
  historyEnd: string | null;
}

/**
 * Full wallet analysis pipeline, see architecture.md §140.
 * fetch (paginated, rate-limited) -> normalize (per-tx tolerant) ->
 * engines -> score -> paths -> persist signals/scores/paths + report.
 */
export async function processAnalysis(job: Job<AnalysisJobData>, ctx: ProcessorContext): Promise<void> {
  const { config } = ctx;
  const { analysisId, walletAddress, chain } = job.data;
  const log = (msg: string) => safeLog(job, msg);

  const sql = ctx.sql;
  const jobRepo = createAnalysisJobRepo(sql);
  const walletRepo = createWalletRepo(sql);
  const analyticsRepo = createWalletAnalyticsRepo(sql);
  const intelligenceRepo = createIntelligenceRepo(sql);
  const entityRepo = createEntityRegistryRepo(sql);

  const provider: BlockchainProvider = createProviderPoolFromConfig(config);

  try {
    await jobRepo.markStarted(analysisId, PIPELINE_VERSION);
    await jobRepo.updateStatus(analysisId, "FETCHING", 10);

    const wallet = await walletRepo.findOrCreate(chain, walletAddress);
    const stats: FetchStats = {
      signaturesFetched: 0,
      transactionsReceived: 0,
      transactionsParsed: 0,
      parserFailures: 0,
      rpcFailures: 0,
      unknownProgramCount: 0,
      historyStart: null,
      historyEnd: null
    };

    // 1. Fetch signatures with pagination (bounded pages) and rate limiting
    const signatures = await fetchSignaturesPaged(provider, walletAddress, config);
    stats.signaturesFetched = signatures.length;
    if (signatures.length === 0) {
      await jobRepo.markFailed(analysisId, "INSUFFICIENT_HISTORY", "No activity found for wallet");
      return;
    }
    await jobRepo.updateStatus(analysisId, "NORMALIZING", 30);

    // 2. Fetch + normalize transactions — one bad tx must not kill the analysis
    const transactions: NormalizedTransaction[] = [];
    const txBudget = config.ANALYSIS_MAX_TRANSACTIONS;
    const pool = createPool(config.ANALYSIS_RPC_CONCURRENCY);

    const tasks = signatures.slice(0, txBudget).map((sig) => async () => {
      let raw;
      try {
        raw = await provider.getTransaction(sig.signature);
      } catch {
        stats.rpcFailures += 1;
        return;
      }
      if (!raw) return;
      stats.transactionsReceived += 1;

      const outcome = normalizeTransaction({
        signature: sig.signature,
        raw: raw.json as ParsedTransactionLike,
        walletAddress,
        rawProvider: provider.name
      });
      stats.unknownProgramCount += outcome.unknownProgramCount;

      if (outcome.failed || !outcome.result) {
        stats.parserFailures += 1;
        log(`parse failed for ${sig.signature.slice(0, 12)}: ${outcome.failureReason}`);
        return;
      }
      stats.transactionsParsed += 1;
      transactions.push(outcome.result.transaction);
    });

    await pool.runAll(tasks);
    log(`fetched ${transactions.length} transactions (rpc failures ${stats.rpcFailures}, parse failures ${stats.parserFailures})`);

    if (transactions.length === 0) {
      await jobRepo.markFailed(
        analysisId,
        "CHAIN_DATA_UNAVAILABLE",
        `No parseable transactions (received ${stats.transactionsReceived}, failed ${stats.parserFailures}, rpc failures ${stats.rpcFailures})`
      );
      return;
    }

    // 3. Persist normalized data — one failing tx must not fail the analysis
    for (const tx of transactions) {
      try {
        const row = await analyticsRepo.insertTransaction({
          signature: tx.signature,
          slot: tx.slot,
          blockTime: tx.blockTime,
          walletId: wallet.id,
          success: tx.success,
          fee: tx.fee,
          transactionClass: tx.transactionClass,
          rawProvider: tx.rawProvider,
          parserVersion: tx.parserVersion
        });
        if (!row.id) continue;
        await analyticsRepo.insertTransfers(
          tx.transfers.map((t) => ({
            transaction_id: row.id,
            from_address: t.fromAddress,
            to_address: t.toAddress,
            asset_type: t.assetType,
            mint: sanitizeNullable(t.mint),
            amount_raw: t.amountRaw,
            amount_normalized: String(t.amountNormalized),
            transfer_type: t.transferType,
            block_time: t.timestamp
          }))
        );
        await analyticsRepo.insertProgramInteractions(
          tx.programInteractions.map((ix) => ({
            wallet_id: wallet.id,
            transaction_id: row.id,
            program_id: ix.programId,
            program_label: sanitizeNullable(ix.programLabel),
            protocol_category: ix.protocolCategory,
            action_type: ix.actionType,
            block_time: ix.blockTime
          }))
        );
      } catch (err) {
        stats.parserFailures += 1;
        console.error(`persist failed for ${tx.signature.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
        log(`persist failed for ${tx.signature.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 4. Load entity registry and run intelligence engines
    const registry = await loadEntityRegistry(entityRepo);
    const allTransfers = transactions.flatMap((t) => t.transfers);
    const allInteractions = transactions.flatMap((t) => t.programInteractions);

    await jobRepo.updateStatus(analysisId, "ENTITY_ANALYSIS", 45);
    const funding = analyzeFunding({ walletAddress, transfers: allTransfers });
    const counterparty = analyzeCounterparties({ walletAddress, transfers: allTransfers });
    const behavior = analyzeBehavior({ walletAddress, transactions, interactions: allInteractions });
    const entities = analyzeEntities({ walletAddress, transfers: allTransfers, interactions: allInteractions, registry });
    const clusters = analyzeClusters({ walletAddress, transfers: allTransfers, sharedCounterparties: new Map() });

    await jobRepo.updateStatus(analysisId, "SCORING", 70);

    // 5. Score
    const sortedByTime = [...transactions].sort((a, b) => a.blockTime.localeCompare(b.blockTime));
    const historyStart = sortedByTime[0]?.blockTime ?? null;
    const historyEnd = sortedByTime[sortedByTime.length - 1]?.blockTime ?? null;
    const historyDays = historyStart
      ? Math.max(1, (Date.now() - new Date(historyStart).getTime()) / 86_400_000)
      : 0;

    const score = scoreWallet({
      repeatedFunding: funding.repeatedFunders.length > 0 ? 70 : 0,
      repeatedCounterparty: counterparty.signals.some((s) => s.type === "REPEATED_COUNTERPARTY") ? 65 : 0,
      knownEntityInteractions: entities.matches.length > 0 ? 55 : 0,
      clusterLinks: clusters.signals.length > 0 ? 50 : 0,
      behavioralSignals: behavior.signals.some((s) => s.severity >= 40) ? 45 : 0,
      counterpartyConcentration: counterparty.counterpartyConcentration,
      uniqueCounterparties: counterparty.uniqueCounterparties,
      fundingConcentration: funding.fundingConcentration,
      transactionCount: transactions.length,
      historyDays,
      parserFailures: stats.parserFailures,
      transactionsRequested: stats.transactionsReceived,
      transactionsReceived: stats.transactionsParsed,
      // D2 §17-§20: calibrated confidence inputs
      unknownProgramRatio:
        allInteractions.length > 0 ? stats.unknownProgramCount / allInteractions.length : 0,
      rpcFailureRatio:
        stats.signaturesFetched > 0 ? stats.rpcFailures / stats.signaturesFetched : 0,
      supportingEngines: [funding, counterparty, behavior, entities, clusters].filter((e) => e.signals.length > 0).length,
      entityCertainty:
        entities.matches.length > 0
          ? entities.matches.reduce((sum, m) => sum + m.confidence, 0) / entities.matches.length
          : 0
    });

    // D2 §15-§16: formal data quality model — measures the dataset, not the wallet
    const dataQualityResult = computeDataQuality({
      transactionsRequested: stats.transactionsReceived,
      transactionsReceived: stats.transactionsReceived,
      transactionsParsed: stats.transactionsParsed,
      parserFailures: stats.parserFailures,
      rpcFailures: stats.rpcFailures,
      unknownProgramCount: stats.unknownProgramCount,
      programInteractionCount: allInteractions.length,
      historyStart,
      historyEnd,
      maxHistoryDays: config.ANALYSIS_MAX_HISTORY_DAYS,
      maxTransactions: config.ANALYSIS_MAX_TRANSACTIONS
    });

    await jobRepo.updateStatus(analysisId, "GRAPH_ANALYSIS", 85);

    // 6. Attack paths
    const relationships = buildRelationshipsFromTransfers(allTransfers, walletAddress);
    const graph = buildGraph(relationships);
    annotateEntities(
      graph,
      entities.matches.map((m) => ({ address: m.address, entityName: m.entity.name }))
    );
    const pathResult = findExposurePaths({ targetAddress: walletAddress, graph });

    await jobRepo.updateStatus(analysisId, "EXPLANATION", 92);

    // 7. Persist intelligence outputs (source of truth)
    const allSignals = [
      ...funding.signals,
      ...counterparty.signals,
      ...behavior.signals,
      ...entities.signals,
      ...clusters.signals
    ];
    await intelligenceRepo.insertSignals(
      allSignals.map((s) => ({
        analysisId,
        walletId: wallet.id,
        signalType: s.type,
        category: s.category,
        severity: s.severity,
        confidence: s.confidence,
        title: s.title,
        summary: s.summary,
        evidence: s.evidence,
        engineVersion: s.engineVersion
      }))
    );
    await intelligenceRepo.insertScore({
      analysisId,
      walletId: wallet.id,
      overallScore: score.overallScore,
      dimensions: score.dimensions,
      overallConfidence: score.overallConfidence,
      scoringVersion: score.scoringVersion
    });
    await intelligenceRepo.insertPaths(
      pathResult.paths.map((p) => ({
        analysisId,
        targetWalletId: wallet.id,
        rank: p.rank,
        pathType: p.pathType,
        nodes: p.nodes,
        edges: p.edges,
        pathScore: p.pathScore,
        confidenceScore: p.confidenceScore,
        summary: p.summary,
        engineVersion: p.engineVersion
      }))
    );

    await jobRepo.updateStatus(analysisId, "PERSISTING", 96);

    // 8. Mark complete with freshness + data quality + RPC observability
    const chainDataUntil = new Date().toISOString();
    const poolStats = provider instanceof ProviderPool ? provider.getStats() : null;
    const dataQuality = {
      ...dataQualityResult,
      transactionsRequested: stats.transactionsReceived,
      transactionsReceived: stats.transactionsReceived,
      transactionsParsed: stats.transactionsParsed,
      parserFailures: stats.parserFailures,
      rpcFailures: stats.rpcFailures,
      unknownProgramCount: stats.unknownProgramCount,
      historyStart,
      historyEnd,
      parserSuccessRate:
        stats.transactionsReceived > 0 ? Math.round((stats.transactionsParsed / stats.transactionsReceived) * 1000) / 10 : 0,
      signaturesFetched: stats.signaturesFetched,
      rpc: poolStats
        ? {
            lastProvider: poolStats.lastProvider,
            circuits: Object.fromEntries(
              Object.entries(poolStats.circuits).map(([name, c]) => [
                name,
                { state: c.state, requestCount: c.requestCount, errorRate: c.errorRate, failovers: c.failovers }
              ])
            )
          }
        : null
    };
    await jobRepo.markCompleted(
      analysisId,
      { chainDataUntil, freshUntil: new Date(Date.now() + config.ANALYSIS_CACHE_TTL_SECONDS * 1000).toISOString() },
      dataQuality
    );

    log(
      `analysis ${analysisId} complete: ${transactions.length} tx parsed, score ${score.overallScore}/${score.overallConfidence}, ` +
        `${allSignals.length} signals, ${pathResult.paths.length} paths, parser failures ${stats.parserFailures}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await jobRepo.markFailed(analysisId, "INTERNAL_ERROR", message.slice(0, 500));
    throw err;
  }
}

async function fetchSignaturesPaged(provider: BlockchainProvider, address: string, config: AppConfig): Promise<Array<{ signature: string; slot: number }>> {
  const all: Array<{ signature: string; slot: number }> = [];
  let before: string | undefined;
  const seen = new Set<string>();
  const pageSize = 100;

  for (let page = 0; page < config.ANALYSIS_MAX_SIGNATURE_PAGES; page++) {
    const sigs = await provider.getSignatures(address, { limit: pageSize, before });
    if (sigs.length === 0) break;
    for (const s of sigs) {
      if (s.blockTime == null) continue;
      if (seen.has(s.signature)) continue;
      seen.add(s.signature);
      all.push({ signature: s.signature, slot: s.slot });
      if (all.length >= config.ANALYSIS_MAX_TRANSACTIONS) return all;
    }
    before = sigs[sigs.length - 1]?.signature;
    if (!before) break;
  }
  return all;
}

/** Bounded parallel pool for RPC fetch tasks, see architecture.md §41. */
function createPool(concurrency: number) {
  return {
    async runAll(tasks: Array<() => Promise<void>>): Promise<void> {
      let index = 0;
      const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
        while (index < tasks.length) {
          const task = tasks[index++];
          if (!task) break;
          await task();
        }
      });
      await Promise.all(workers);
    }
  };
}

async function loadEntityRegistry(entityRepo: ReturnType<typeof createEntityRegistryRepo>): Promise<EntityRegistry> {
  const [entities, addresses] = await Promise.all([entityRepo.listEntities(), entityRepo.findAddressesByChain("solana")]);
  return {
    entities: entities.map((e: EntitySeedRow) => ({
      id: e.id,
      name: e.name,
      entityType: e.entity_type as EntityRegistry["entities"][number]["entityType"],
      description: null,
      status: e.status as EntityRegistry["entities"][number]["status"],
      defaultConfidence: Number(e.default_confidence),
      sourceType: e.source_type,
      createdAt: "",
      updatedAt: ""
    })),
    addresses: addresses.map((a: EntityAddressSeedRow) => ({
      id: a.id,
      entityId: a.entity_id,
      chain: a.chain as "solana",
      address: a.address,
      label: a.label,
      confidence: Number(a.confidence),
      evidenceSource: a.evidence_source,
      firstVerifiedAt: null,
      lastVerifiedAt: null,
      status: a.status as EntityRegistry["addresses"][number]["status"]
    }))
  };
}

/** Builds relationship edges from transfer pairs for the attack graph. */
function buildRelationshipsFromTransfers(transfers: NormalizedTransaction["transfers"], walletAddress: string): WalletRelationship[] {
  const pairs = new Map<string, WalletRelationship>();
  const now = new Date().toISOString();

  for (const t of transfers) {
    if (t.fromAddress === t.toAddress) continue;
    const counterparty = t.fromAddress === walletAddress ? t.toAddress : t.fromAddress;
    const key = [walletAddress, counterparty].sort().join("|");
    const existing = pairs.get(key);
    if (existing) {
      existing.transactionCount += 1;
      existing.totalValue += t.amountNormalized;
      existing.lastSeen = t.timestamp;
      existing.strengthScore = relationshipStrengthFromCount(existing.transactionCount);
    } else {
      pairs.set(key, {
        id: key,
        walletA: walletAddress,
        walletB: counterparty,
        relationshipType: t.fromAddress === walletAddress ? "FUNDS" : "FUNDED_BY",
        direction: "BIDIRECTIONAL",
        transactionCount: 1,
        interactionCount: 1,
        totalValue: t.amountNormalized,
        firstSeen: t.timestamp,
        lastSeen: t.timestamp,
        strengthScore: relationshipStrengthFromCount(1),
        confidenceScore: 0.7,
        evidenceJson: {},
        engineVersion: "relationship-v1.0.0",
        createdAt: now,
        updatedAt: now
      });
    }
  }
  return [...pairs.values()];
}

/** Relationship strength from interaction count, see architecture.md §20. */
function relationshipStrengthFromCount(count: number): number {
  return Math.min(1, 0.2 + 0.1 * Math.log10(1 + count * 2));
}

/** postgres.js rejects undefined values; normalize them to null at the data boundary. */
function sanitizeNullable(value: string | null | undefined): string | null {
  return value ?? null;
}

/** job.log can throw when the job key is missing from Redis; logging must never crash the pipeline. */
function safeLog(job: Job<AnalysisJobData>, message: string): void {
  try {
    job.log(message);
  } catch {
    // ignore — logging is best-effort
  }
}

export type { IntelligenceSignal, ScoreResult };
