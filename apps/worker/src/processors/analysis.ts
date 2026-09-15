import type { Job } from "bullmq";
import type { AppConfig } from "@aegix/config";
import type { BlockchainProvider } from "@aegix/blockchain";
import { classifyAddress, createProviderPoolFromConfig, isAnalysisEligible, ProviderPool } from "@aegix/blockchain";
import {
  createAnalysisJobRepo,
  createBehavioralFeatureRepo,
  createCorrelationRepo,
  createDb,
  createEntityRegistryRepo,
  createFundingPathRepo,
  createIntelligenceRepo,
  createRelationshipClusterRepo,
  createRelationshipRepo,
  createWalletAnalyticsRepo,
  createWalletRepo,
  type EntityAddressSeedRow,
  type EntitySeedRow
} from "@aegix/database";
import { normalizeTransaction, type ParsedTransactionLike } from "@aegix/normalizer";
import { ANALYSIS_PIPELINE_VERSION } from "@aegix/types";
import type { IntelligenceSignal, NormalizedTransaction, WalletRelationship } from "@aegix/types";
import {
  analyzeBehavior,
  analyzeClusters,
  analyzeCounterparties,
  analyzeEntities,
  analyzeFunding,
  analyzeLinkability,
  analyzePublicAttribution,
  analyzeTransactionPatterns,
  type EntityRegistry
} from "@aegix/intelligence";
import { scoreWallet, computeDataQuality, type ScoreResult } from "@aegix/scoring";
import { annotateEntities, buildGraph, findExposurePaths, findRelationshipPaths, buildRelationshipClusters, type ClusterEdge } from "@aegix/graph";
import { traceFundingProvenance, correlationResultsToInferredEdges } from "@aegix/correlation";
import { explainPath, explainSignal } from "@aegix/explanation";
import { walletRef } from "@aegix/logging";
import type { AnalysisJobData } from "@aegix/queue";
import type { ProcessorContext } from "../worker.js";
import { createNetworkQuery } from "@aegix/network";
import { getIndexedTransaction } from "../indexed-transaction.js";

const PIPELINE_VERSION = ANALYSIS_PIPELINE_VERSION;

interface FetchStats {
  signaturesFetched: number;
  transactionsRequested: number;
  transactionsReceived: number;
  transactionsParsed: number;
  parserFailures: number;
  rpcFailures: number;
  unknownProgramCount: number;
  historyStart: string | null;
  historyEnd: string | null;
  fullyParsed: number;
  partiallyParsed: number;
  genericParsed: number;
  /** average semantic coverage across parsed transactions, 0-1 */
  semanticCoverage: number;
  signaturePages: number;
  rpcBudgetExhausted: boolean;
  timeBudgetExhausted: boolean;
  unknownPrograms: Map<string, {
    instructionCount: number;
    transactionCount: number;
    sampleSignatures: string[];
    firstObservedSlot: number;
    lastObservedSlot: number;
  }>;
}

/**
 * Full wallet analysis pipeline, see architecture.md §140.
 * fetch (paginated, rate-limited) -> normalize (per-tx tolerant) ->
 * engines -> score -> paths -> persist signals/scores/paths + report.
 */
export async function processAnalysis(job: Job<AnalysisJobData>, ctx: ProcessorContext): Promise<void> {
  const { config, logger: baseLogger } = ctx;
  const { analysisId, walletAddress, chain } = job.data;
  const ref = walletRef(walletAddress);
  const logger = baseLogger.child({ analysisId, jobId: job.id, ...ref });
  const log = (msg: string) => safeLog(job, msg);
  const startedAt = Date.now();

  const sql = ctx.sql;
  const jobRepo = createAnalysisJobRepo(sql);
  const walletRepo = createWalletRepo(sql);
  const analyticsRepo = createWalletAnalyticsRepo(sql);
  const intelligenceRepo = createIntelligenceRepo(sql);
  const entityRepo = createEntityRegistryRepo(sql);
  const indexed = config.ENABLE_INDEXED_TRANSACTIONS ? createNetworkQuery(sql) : null;

  const provider: BlockchainProvider = createProviderPoolFromConfig(config);

  try {
    // Account classification before expensive work, see D3-A §8.
    const classification = await classifyAddress(provider, walletAddress);
    if (!isAnalysisEligible(classification.accountType)) {
      logger.warn("account not analyzable, skipping analysis", { accountType: classification.accountType, protocol: classification.protocol });
      await jobRepo.markFailed(
        analysisId,
        "ACCOUNT_NOT_ANALYZABLE",
        `Address is a ${classification.accountType.toLowerCase()} and is not analyzed as a personal wallet`
      );
      return;
    }

    await jobRepo.markStarted(analysisId, PIPELINE_VERSION);
    await jobRepo.updateStatus(analysisId, "FETCHING", 10);

    const wallet = await walletRepo.findOrCreate(chain, walletAddress);
    const stats: FetchStats = {
      signaturesFetched: 0,
      transactionsRequested: 0,
      transactionsReceived: 0,
      transactionsParsed: 0,
      parserFailures: 0,
      rpcFailures: 0,
      unknownProgramCount: 0,
      historyStart: null,
      historyEnd: null,
      fullyParsed: 0,
      partiallyParsed: 0,
      genericParsed: 0,
      semanticCoverage: 0,
      signaturePages: 0,
      rpcBudgetExhausted: false,
      timeBudgetExhausted: false,
      unknownPrograms: new Map()
    };

    // 1. Fetch signatures with pagination (bounded pages) and rate limiting
    const fetchStarted = Date.now();
    const signatureResult = await fetchSignaturesPaged(provider, walletAddress, config);
    const signatures = signatureResult.signatures;
    stats.signaturePages = signatureResult.pagesAttempted;
    const fetchMs = Date.now() - fetchStarted;
    stats.signaturesFetched = signatures.length;
    if (signatures.length === 0) {
      logger.warn("no activity found for wallet", { stage: "fetch", durationMs: fetchMs });
      await jobRepo.markFailed(analysisId, "INSUFFICIENT_HISTORY", "No activity found for wallet");
      return;
    }
    logger.info("signatures fetched", { stage: "fetch", durationMs: fetchMs, signatures: signatures.length });
    await jobRepo.updateStatus(analysisId, "NORMALIZING", 30);

    // 2. Fetch + normalize transactions — one bad tx must not kill the analysis
    const transactions: NormalizedTransaction[] = [];
    const txBudget = Math.min(
      config.ANALYSIS_MAX_TRANSACTIONS,
      Math.max(0, config.ANALYSIS_MAX_RPC_CALLS - stats.signaturePages - 1)
    );
    if (txBudget < signatures.length) stats.rpcBudgetExhausted = true;
    stats.transactionsRequested = Math.min(signatures.length, txBudget);
    const pool = createPool(config.ANALYSIS_RPC_CONCURRENCY);

    const tasks = signatures.slice(0, txBudget).map((sig) => async () => {
      if (Date.now() - startedAt >= config.ANALYSIS_TIMEOUT_MS) {
        stats.timeBudgetExhausted = true;
        return;
      }
      let raw;
      let rawSource = provider.name;
      try {
        const result = await getIndexedTransaction(sig.signature, provider,
          indexed ? signature => indexed.transaction("solana:mainnet", signature) : undefined);
        raw = result.transaction;
        rawSource = result.source;
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
        rawProvider: rawSource
      });
      stats.unknownProgramCount += outcome.unknownProgramCount;
      for (const unknown of outcome.unknownPrograms) {
        const current = stats.unknownPrograms.get(unknown.programId);
        if (current) {
          current.instructionCount += unknown.instructionCount;
          current.transactionCount += 1;
          current.firstObservedSlot = Math.min(current.firstObservedSlot, sig.slot);
          current.lastObservedSlot = Math.max(current.lastObservedSlot, sig.slot);
          if (current.sampleSignatures.length < 3) current.sampleSignatures.push(sig.signature);
        } else if (stats.unknownPrograms.size < 50) {
          stats.unknownPrograms.set(unknown.programId, {
            instructionCount: unknown.instructionCount,
            transactionCount: 1,
            sampleSignatures: [sig.signature],
            firstObservedSlot: sig.slot,
            lastObservedSlot: sig.slot
          });
        }
      }

      if (outcome.failed || !outcome.result) {
        stats.parserFailures += 1;
        log(`parse failed for ${sig.signature.slice(0, 12)}: ${outcome.failureReason}`);
        return;
      }
      stats.transactionsParsed += 1;
      stats.semanticCoverage += outcome.semanticCoverage;
      if (outcome.parseClass === "FULLY_PARSED") stats.fullyParsed += 1;
      else if (outcome.parseClass === "PARTIALLY_PARSED") stats.partiallyParsed += 1;
      else stats.genericParsed += 1;
      transactions.push(outcome.result.transaction);
    });

    const normalizeStarted = Date.now();
    await pool.runAll(tasks);
    const normalizeMs = Date.now() - normalizeStarted;
    logger.info("transactions fetched and normalized", {
      stage: "normalize",
      durationMs: normalizeMs,
      parsed: transactions.length,
      rpcFailures: stats.rpcFailures,
      parseFailures: stats.parserFailures
    });

    if (transactions.length === 0) {
      await jobRepo.markFailed(
        analysisId,
        "CHAIN_DATA_UNAVAILABLE",
        `No parseable transactions (received ${stats.transactionsReceived}, failed ${stats.parserFailures}, rpc failures ${stats.rpcFailures})`
      );
      return;
    }

    // 3. Persist normalized data — one failing tx must not fail the analysis
    const persistStarted = Date.now();
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
        const message = err instanceof Error ? err.message : String(err);
        logger.error("persist failed", { signature: tx.signature.slice(0, 12), error: message });
        log(`persist failed for ${tx.signature.slice(0, 12)}: ${message}`);
      }
    }
    const persistMs = Date.now() - persistStarted;
    logger.info("transactions persisted", { stage: "persist", durationMs: persistMs });

    // 4. Load entity registry and run intelligence engines
    const registry = await loadEntityRegistry(entityRepo);
    const allTransfers = transactions.flatMap((t) => t.transfers);
    const allInteractions = transactions.flatMap((t) => t.programInteractions);

    const enginesStarted = Date.now();
    await jobRepo.updateStatus(analysisId, "ENTITY_ANALYSIS", 45);
    const funding = analyzeFunding({ walletAddress, transfers: allTransfers });
    const counterparty = analyzeCounterparties({ walletAddress, transfers: allTransfers });
    const behavior = analyzeBehavior({ walletAddress, transactions, interactions: allInteractions });
    const entities = analyzeEntities({ walletAddress, transfers: allTransfers, interactions: allInteractions, registry });

    // D5-B: populate shared-counterparty evidence from other analyzed
    // wallets (bounded). This activates the cluster engine, which previously
    // always received an empty map. Best-effort: cross-wallet discovery must
    // never fail an analysis.
    let clusters = analyzeClusters({ walletAddress, transfers: allTransfers, sharedCounterparties: new Map() });
    try {
      const sharedCounterparties = await sharedCounterpartiesForWallet(
        sql,
        wallet.id,
        walletAddress,
        allTransfers,
        config.MAX_CORRELATION_CANDIDATE_WALLETS
      );
      clusters = analyzeClusters({ walletAddress, transfers: allTransfers, sharedCounterparties });
      logger.info("cluster engine populated", { stage: "engines", shared: sharedCounterparties.size, signals: clusters.signals.length });
    } catch (err) {
      logger.warn("shared-counterparty discovery failed, cluster engine empty", { error: err instanceof Error ? err.message : String(err) });
    }
    // Transaction-pattern and public-attribution evidence. These populate the
    // TRANSACTION_PATTERN and PUBLIC_ATTRIBUTION signal categories and supply
    // the score components that were previously stood in by proxies.
    const txPatterns = analyzeTransactionPatterns({ walletAddress, transactions, transfers: allTransfers });
    const publicAttribution = analyzePublicAttribution({
      walletAddress,
      transfers: allTransfers,
      matches: entities.matches,
      registry
    });

    // Linkability reads the other engines' output rather than chain data, so
    // it runs last. Its exposure value is deliberately not fed back into
    // scoring — identityLinkability is already computed from the same
    // underlying evidence, and feeding it back would double-count.
    const evidenceSignals = [
      ...funding.signals,
      ...counterparty.signals,
      ...behavior.signals,
      ...entities.signals,
      ...clusters.signals,
      ...txPatterns.signals,
      ...publicAttribution.signals
    ];
    const linkability = analyzeLinkability({ walletAddress, signals: evidenceSignals });

    const enginesMs = Date.now() - enginesStarted;
    logger.info("intelligence engines complete", {
      stage: "engines",
      durationMs: enginesMs,
      signals: evidenceSignals.length + linkability.signals.length,
      publicAttributionExposure: publicAttribution.publicAttributionExposure,
      linkabilityConverged: linkability.converged
    });

    await jobRepo.updateStatus(analysisId, "SCORING", 70);

    // 5. Score
    const sortedByTime = [...transactions].sort((a, b) => a.blockTime.localeCompare(b.blockTime));
    const historyStart = sortedByTime[0]?.blockTime ?? null;
    const historyEnd = sortedByTime[sortedByTime.length - 1]?.blockTime ?? null;
    const historyDays = historyStart
      ? Math.max(1, (Date.now() - new Date(historyStart).getTime()) / 86_400_000)
      : 0;

    const scoringStarted = Date.now();
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
      transactionsRequested: stats.transactionsRequested,
      transactionsReceived: stats.transactionsReceived,
      // D2 §17-§20: calibrated confidence inputs
      unknownProgramRatio:
        allInteractions.length > 0 ? stats.unknownProgramCount / allInteractions.length : 0,
      rpcFailureRatio:
        stats.transactionsRequested > 0 ? stats.rpcFailures / stats.transactionsRequested : 0,
      supportingEngines: [funding, counterparty, behavior, entities, clusters, txPatterns, publicAttribution].filter(
        (e) => e.signals.length > 0
      ).length,
      publicAttribution: publicAttribution.publicAttributionExposure,
      largeTransferExposure: txPatterns.largeTransferExposure,
      highFrequencyExposure: txPatterns.highFrequencyExposure,
      oddHourExposure: txPatterns.oddHourExposure,
      regularIntervalExposure: txPatterns.regularIntervalExposure,
      entityCertainty:
        entities.matches.length > 0
          ? entities.matches.reduce((sum, m) => sum + m.confidence, 0) / entities.matches.length
          : 0
    });
    const scoringMs = Date.now() - scoringStarted;
    logger.info("scoring complete", { stage: "scoring", durationMs: scoringMs, score: score.overallScore, confidence: score.overallConfidence });

    // D2 §15-§16: formal data quality model — measures the dataset, not the wallet
    const dataQualityResult = computeDataQuality({
      transactionsRequested: stats.transactionsRequested,
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
    const graphStarted = Date.now();
    const relationships = buildRelationshipsFromTransfers(allTransfers, walletAddress);
    const graph = buildGraph(relationships);
    annotateEntities(
      graph,
      entities.matches.map((m) => ({ address: m.address, entityName: m.entity.name }))
    );
    const pathResult = findExposurePaths({ targetAddress: walletAddress, graph });
    const graphMs = Date.now() - graphStarted;
    logger.info("attack graph complete", { stage: "graph", durationMs: graphMs, paths: pathResult.paths.length, nodes: graph.nodes.size, edges: graph.edges.size });

    await jobRepo.updateStatus(analysisId, "EXPLANATION", 92);

    // 7. Persist intelligence outputs (source of truth)
    const allSignals = [...evidenceSignals, ...linkability.signals];
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

    // D5-D: persist behavioral feature distributions so the correlation
    // engine can compare wallets without re-running analysis.
    const behaviorRepo = createBehavioralFeatureRepo(sql);
    await behaviorRepo.upsertFeatures(wallet.id, [
      { featureName: "activityHourDistribution", valueNumber: null, valueJson: behavior.activityHourDistribution, sampleSize: transactions.length, engineVersion: behavior.signals[0]?.engineVersion ?? "behavior-v1.0.0" },
      { featureName: "weekdayDistribution", valueNumber: null, valueJson: behavior.weekdayDistribution, sampleSize: transactions.length, engineVersion: behavior.signals[0]?.engineVersion ?? "behavior-v1.0.0" },
      { featureName: "protocolDistribution", valueNumber: null, valueJson: behavior.protocolDistribution, sampleSize: allInteractions.length, engineVersion: behavior.signals[0]?.engineVersion ?? "behavior-v1.0.0" },
      { featureName: "transferSizeDistribution", valueNumber: null, valueJson: behavior.transferSizeDistribution, sampleSize: allTransfers.length, engineVersion: behavior.signals[0]?.engineVersion ?? "behavior-v1.0.0" },
      { featureName: "txIntervalDistribution", valueNumber: null, valueJson: behavior.txIntervalDistribution, sampleSize: Math.max(0, transactions.length - 1), engineVersion: behavior.signals[0]?.engineVersion ?? "behavior-v1.0.0" }
    ]);

    // D5-G: persist direct funding/transfer relationships (the table existed
    // since 0001 but was never written). Best-effort — analysis must not fail
    // on relationship persistence.
    try {
      const relationshipRepo = createRelationshipRepo(sql);
      for (const rel of relationships) {
        await relationshipRepo.upsert({
          walletA: rel.walletA,
          walletB: rel.walletB,
          relationshipType: rel.relationshipType,
          direction: rel.direction,
          transactionCount: rel.transactionCount,
          interactionCount: rel.interactionCount,
          totalValue: rel.totalValue,
          firstSeen: rel.firstSeen,
          lastSeen: rel.lastSeen,
          strengthScore: rel.strengthScore,
          confidenceScore: rel.confidenceScore,
          evidence: rel.evidenceJson,
          engineVersion: rel.engineVersion
        });
      }
    } catch (err) {
      logger.warn("relationship persistence failed", { error: err instanceof Error ? err.message : String(err) });
    }

    // D5-C: bounded funding provenance (persisted for the x-ray UI).
    if (config.ENABLE_CORRELATION_ANALYSIS) {
      try {
        const fundingPathRepo = createFundingPathRepo(sql);
        const entityAddresses = new Map(
          (await entityRepo.findAddressesByChain("solana"))
            .filter((a) => a.status === "VERIFIED")
            .map((a) => [a.address, a.label ?? a.address])
        );
        const paths = await traceFundingProvenance({
          targetWallet: walletAddress,
          targetTransfers: allTransfers.map((t) => ({
            id: "",
            transaction_id: t.transactionId,
            from_address: t.fromAddress,
            to_address: t.toAddress,
            asset_type: t.assetType,
            mint: t.mint,
            amount_raw: t.amountRaw,
            amount_normalized: String(t.amountNormalized),
            transfer_type: t.transferType,
            block_time: t.timestamp
          })),
          fetchTransfers: async () => [], // DB-backed expansion lands in D5-G; no RPC crawling here
          knownEntities: entityAddresses,
          maxHops: 2,
          maxWallets: config.MAX_SECONDARY_WALLETS,
          maxTransfers: config.MAX_SECONDARY_TRANSACTIONS
        });
        if (paths.length > 0) {
          await fundingPathRepo.replaceForTarget(wallet.id, paths.map((p) => ({
            path: p.hops,
            pathScore: p.pathScore,
            pathConfidence: p.pathConfidence,
            terminusType: p.terminusType,
            terminusAddress: p.terminusAddress,
            terminusEntityName: p.terminusEntityName,
            engineVersion: p.engineVersion
          })));
        }
      } catch (err) {
        logger.warn("funding provenance failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // D5-G: bounded multi-hop relationship graph (persisted data first,
    // DB-backed expansion only — never RPC crawling). D5-H: conservative
    // relationship cluster hypothesis. Both are best-effort; the analysis
    // must never fail on them.
    if (config.ENABLE_CORRELATION_ANALYSIS) {
      try {
        const graphStarted = Date.now();
        const entityNames = new Map<string, string>();
        for (const addr of await entityRepo.findAddressesByChain("solana")) {
          if (addr.status === "VERIFIED") entityNames.set(addr.address, addr.label ?? addr.address);
        }
        const clusterEdges: ClusterEdge[] = [];
        const relationshipRepo = createRelationshipRepo(sql);

        // D5-I §5-§12: persisted correlation_results become qualified
        // CORRELATED_WITH inferred edges (bounded to the analyzed wallet).
        const correlationRepo = createCorrelationRepo(sql);
        const persistedCorrelations = await correlationRepo.listForWallet(walletAddress, config.MAX_CORRELATION_CANDIDATE_WALLETS);
        const inferred = correlationResultsToInferredEdges(
          persistedCorrelations.map((row) => ({
            walletA: row.wallet_a,
            walletB: row.wallet_b,
            correlationScore: row.correlation_score,
            confidence: Number(row.confidence),
            evidenceFamilies: ((row.evidence_families ?? []) as Array<{ family: string; strength: number; confidence: number; engineVersion: string }>).map((f) => ({
              family: f.family,
              strength: Number(f.strength),
              confidence: Number(f.confidence),
              engineVersion: f.engineVersion ?? "unknown"
            })),
            limitations: (row.limitations ?? []) as string[],
            engineVersion: row.engine_version,
            pairId: [row.wallet_a, row.wallet_b].sort().join("|")
          })),
          {
            minScore: config.MIN_INFERRED_EDGE_SCORE,
            minConfidence: config.MIN_INFERRED_EDGE_CONFIDENCE,
            minEvidenceFamilies: config.MIN_INFERRED_EDGE_EVIDENCE_FAMILIES,
            minSample: 0,
            minSemanticCoverage: 0,
            strongDirectScore: config.INFERRED_EDGE_STRONG_DIRECT_SCORE
          }
        );
        logger.info("inferred edges admitted", {
          stage: "graph",
          candidateCorrelations: persistedCorrelations.length,
          inferredEdges: inferred.edges.length,
          rejected: inferred.rejections.length
        });

        const graphResult = await findRelationshipPaths({
          targetWallet: walletAddress,
          relationships,
          inferredEdges: inferred.edges.map((e) => ({
            walletA: e.source,
            walletB: e.target,
            type: e.type,
            strength: e.strength,
            confidence: e.confidence,
            evidence: e.evidence,
            sourceEngine: e.sourceEngine,
            engineVersion: e.engineVersion
          })),
          commonality: new Map(
            [...entityNames.keys()].map((addr) => [addr, 0.9]) // known verified entities are common by definition
          ),
          fetchRelationships: async (addr) => {
            // DB-backed secondary expansion, bounded by config.
            const rows = await relationshipRepo.listForWallet(addr, config.MAX_SECONDARY_WALLETS * 2);
            return rows.map((r) => ({
              id: String(r.id),
              walletA: r.wallet_a,
              walletB: r.wallet_b,
              relationshipType: r.relationship_type as WalletRelationship["relationshipType"],
              direction: r.direction as WalletRelationship["direction"],
              transactionCount: r.transaction_count,
              interactionCount: r.interaction_count,
              totalValue: Number(r.total_value),
              firstSeen: r.first_seen,
              lastSeen: r.last_seen,
              strengthScore: Number(r.strength_score),
              confidenceScore: Number(r.confidence_score),
              evidenceJson: r.evidence_json,
              engineVersion: r.engine_version,
              createdAt: r.created_at,
              updatedAt: r.updated_at
            }));
          },
          limits: {
            maxDepth: config.GRAPH_MAX_DEPTH,
            maxNodes: config.GRAPH_MAX_NODES,
            maxEdges: config.GRAPH_MAX_EDGES,
            maxSecondaryWallets: config.MAX_SECONDARY_WALLETS,
            maxSecondaryRpcCalls: config.MAX_SECONDARY_RPC_CALLS,
            maxGraphTimeMs: config.GRAPH_MAX_TIME_MS
          }
        });

        // Feed observed + inferred edges into the cluster engine (D5-H,
        // D5-I §13-§16). Inferred correlation edges only enter with their
        // correlation evidence families; the cluster engine's conservative
        // admission (multi-evidence / strong direct) still applies, so weak
        // inferred edges never merge clusters and hub-penalized paths stay out.
        for (const edge of graphResult.edges) {
          const direct = edge.type === "FUNDED" || edge.type === "TRANSFERRED" || edge.type === "RECEIVED_FROM";
          const families = edge.observationClass === "OBSERVED"
            ? [edge.type === "FUNDED" || edge.type === "RECEIVED_FROM" ? "FUNDING" : "TRANSFER"]
            : edge.type === "CORRELATED_WITH"
              ? ((edge.evidence ?? []).filter((e) => /^[A-Z_]+:/.test(e)).map((e) => e.split(":")[0]!).filter((f) => f !== "correlation_result"))
              : [edge.type];
          if (families.length === 0) continue;
          clusterEdges.push({
            walletA: edge.source,
            walletB: edge.target,
            evidenceFamilies: [...new Set(families)],
            strength: edge.strength,
            confidence: edge.confidence,
            direct
          });
        }
        const clusterResult = buildRelationshipClusters({
          targetWallet: walletAddress,
          edges: clusterEdges,
          entityAddresses: new Set(entityNames.keys()),
          dataQuality: new Map([[walletAddress, dataQualityResult.dataQualityScore / 100]]),
          limits: { maxClusterSize: config.CLUSTER_MAX_SIZE }
        });

        // Persist paths (idempotent replace per analysis).
        await intelligenceRepo.insertPaths(
          graphResult.paths.map((p) => ({
            analysisId,
            targetWalletId: wallet.id,
            rank: p.path.rank,
            pathType: p.path.pathType,
            nodes: p.path.nodes,
            edges: p.path.edges,
            pathScore: p.path.pathScore,
            confidenceScore: p.path.confidenceScore,
            summary: p.path.summary,
            engineVersion: p.path.engineVersion
          }))
        );
        // Persist cluster hypotheses (idempotent replace per analysis).
        await replaceClustersForAnalysis(sql, analysisId, wallet.id, clusterResult.clusters);
        const graphMs = Date.now() - graphStarted;
        logger.info("block2 graph+cluster complete", {
          stage: "graph",
          durationMs: graphMs,
          paths: graphResult.paths.length,
          nodes: graphResult.nodeCount,
          edges: graphResult.edgeCount,
          stopReason: graphResult.stopReason,
          secondaryFetched: graphResult.secondaryWalletsFetched,
          rpcConsumed: graphResult.rpcCallsConsumed,
          clusters: clusterResult.clusters.length,
          clusterMembers: clusterResult.clusters.reduce((s, c) => s + c.members.length, 0)
        });
      } catch (err) {
        logger.warn("block2 relationship graph/cluster failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    await jobRepo.updateStatus(analysisId, "PERSISTING", 96);

    // 8. Mark complete with freshness + data quality + RPC observability
    const chainDataUntil = new Date().toISOString();
    const poolStats = provider instanceof ProviderPool ? provider.getStats() : null;
    const dataQuality = {
      ...dataQualityResult,
      transactionsRequested: stats.transactionsRequested,
      transactionsReceived: stats.transactionsReceived,
      transactionsParsed: stats.transactionsParsed,
      parserFailures: stats.parserFailures,
      rpcFailures: stats.rpcFailures,
      unknownProgramCount: stats.unknownProgramCount,
      historyStart,
      historyEnd,
      parserSuccessRate:
        stats.transactionsReceived > 0 ? Math.round((stats.transactionsParsed / stats.transactionsReceived) * 1000) / 10 : 0,
      fullyParsed: stats.fullyParsed,
      partiallyParsed: stats.partiallyParsed,
      genericParsed: stats.genericParsed,
      semanticCoverage:
        stats.transactionsParsed > 0 ? Math.round((stats.semanticCoverage / stats.transactionsParsed) * 1000) / 10 : 0,
      signaturesFetched: stats.signaturesFetched,
      signaturePages: stats.signaturePages,
      coverageDisclosure: {
        scope: "MOST_RECENT_BOUNDED",
        maxSignatures: config.ANALYSIS_MAX_TRANSACTIONS,
        maxTransactions: txBudget,
        maxRpcCalls: config.ANALYSIS_MAX_RPC_CALLS,
        maxHistoryDays: config.ANALYSIS_MAX_HISTORY_DAYS,
        maxExecutionTimeMs: config.ANALYSIS_TIMEOUT_MS,
        rpcBudgetExhausted: stats.rpcBudgetExhausted,
        timeBudgetExhausted: stats.timeBudgetExhausted,
        someInteractionsUnclassified: stats.unknownProgramCount > 0 || stats.partiallyParsed > 0
      },
      unknownPrograms: [...stats.unknownPrograms.entries()]
        .map(([programId, metric]) => ({ programId, ...metric }))
        .sort((a, b) => b.instructionCount - a.instructionCount || b.transactionCount - a.transactionCount)
        .slice(0, 20),
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

    // D6-G §92: incremental population aggregation (opt-in). Idempotent per
    // (wallet, version) — re-analysis replaces the wallet's contribution.
    // Best-effort: aggregation failure must never fail the analysis.
    if (config.ENABLE_POPULATION_COMMONALITY) {
      try {
        const { aggregatePopulation } = await import("@aegix/commonality");
        const agg = await aggregatePopulation(ctx, {
          walletId: wallet.id,
          analysisId,
          version: config.COMMONALITY_VERSION
        });
        logger.info("population aggregation complete", {
          walletId: wallet.id,
          populationSize: agg.populationSize,
          observations: agg.observations,
          version: config.COMMONALITY_VERSION
        });
      } catch (err) {
        logger.error("population aggregation failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // D4-B §14 / D4-I §75: fan out to monitors watching this wallet. One
    // analysis serves every monitor — the monitoring worker runs the
    // diff/rules pipeline per monitor. Best-effort: a queue failure must
    // never fail the analysis itself.
    if (config.ENABLE_MONITORING) {
      try {
        await ctx.queues.monitoring.add(
          "monitor-diff",
          { kind: "diff", analysisId, walletId: wallet.id },
          { jobId: `monitor-diff-${analysisId}`, attempts: 1, removeOnComplete: 100 }
        );
      } catch (err) {
        logger.error("monitor fan-out enqueue failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const totalMs = Date.now() - startedAt;
    logger.info("analysis complete", {
      stage: "total",
      durationMs: totalMs,
      transactionsParsed: transactions.length,
      score: score.overallScore,
      confidence: score.overallConfidence,
      signals: allSignals.length,
      paths: pathResult.paths.length,
      parserFailures: stats.parserFailures,
      rpcFailures: stats.rpcFailures,
      dataQualityScore: dataQualityResult.dataQualityScore
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("analysis failed", { stage: "pipeline", error: message, durationMs: Date.now() - startedAt });
    await jobRepo.markFailed(analysisId, "INTERNAL_ERROR", message.slice(0, 500));
    throw err;
  }
}

async function fetchSignaturesPaged(provider: BlockchainProvider, address: string, config: AppConfig): Promise<{ signatures: Array<{ signature: string; slot: number }>; pagesAttempted: number }> {
  const all: Array<{ signature: string; slot: number }> = [];
  let before: string | undefined;
  const seen = new Set<string>();
  const maxPageSize = 1000;
  const historyCutoffSeconds = Math.floor(Date.now() / 1000) - config.ANALYSIS_MAX_HISTORY_DAYS * 86_400;
  let consecutiveFailures = 0;
  let pagesAttempted = 0;

  for (let page = 0; page < config.ANALYSIS_MAX_SIGNATURE_PAGES; page++) {
    pagesAttempted += 1;
    let sigs;
    try {
      sigs = await provider.getSignatures(address, {
        limit: Math.min(maxPageSize, config.ANALYSIS_MAX_TRANSACTIONS - all.length),
        before
      });
    } catch {
      // A failed signature page must not fail the whole analysis: rate limits
      // and transient RPC errors are expected under load. Skip forward and
      // keep whatever we already have.
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3 || all.length === 0) throw new Error("RPC_UNAVAILABLE: signature fetch failed repeatedly");
      continue;
    }
    consecutiveFailures = 0;
    if (sigs.length === 0) break;
    for (const s of sigs) {
      if (s.blockTime == null) continue;
      if (s.blockTime < historyCutoffSeconds) return { signatures: all, pagesAttempted };
      if (seen.has(s.signature)) continue;
      seen.add(s.signature);
      all.push({ signature: s.signature, slot: s.slot });
      if (all.length >= config.ANALYSIS_MAX_TRANSACTIONS) return { signatures: all, pagesAttempted };
    }
    before = sigs[sigs.length - 1]?.signature;
    if (!before) break;
  }
  return { signatures: all, pagesAttempted };
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
      firstVerifiedAt: a.first_verified_at,
      lastVerifiedAt: a.last_verified_at,
      status: a.status as EntityRegistry["addresses"][number]["status"],
      addressRole: (a.address_role ?? "UNKNOWN_ROLE") as EntityRegistry["addresses"][number]["addressRole"],
      deprecatedAt: a.deprecated_at,
      notes: a.notes
    }))
  };
}

/**
 * D5-B: finds counterparties of this wallet that other analyzed wallets also
 * interact with (bounded scan). Returns address -> share count. Reads only
 * persisted data — no RPC.
 */
async function sharedCounterpartiesForWallet(
  sql: ProcessorContext["sql"],
  walletId: string,
  walletAddress: string,
  allTransfers: NormalizedTransaction["transfers"],
  maxCandidates: number
): Promise<Map<string, number>> {
  const analyticsRepo = createWalletAnalyticsRepo(sql);
  const myCounterparties = new Set<string>();
  for (const t of allTransfers) {
    const cp = t.fromAddress === walletAddress ? t.toAddress : t.toAddress === walletAddress ? t.fromAddress : null;
    if (cp && cp !== walletAddress) myCounterparties.add(cp);
  }
  if (myCounterparties.size === 0) return new Map();

  // Other wallets that share at least one of our counterparties. The
  // wallet_id lives on `transactions`, not `transfers`, so join through
  // the owning transaction.
  const rows = await sql<Array<{ wallet_id: string }>>`
    select distinct tx.wallet_id::text as wallet_id
    from transfers t
    join transactions tx on tx.id = t.transaction_id
    join analysis_jobs aj on aj.wallet_id = tx.wallet_id and aj.status = 'READY'
    where tx.wallet_id <> ${walletId}
      and (t.from_address = any(${[...myCounterparties]}) or t.to_address = any(${[...myCounterparties]}))
    limit ${maxCandidates}
  `;

  const shared = new Map<string, number>();
  for (const row of rows) {
    const counterparties = await analyticsRepo.counterpartiesForWallet(row.wallet_id, 200);
    for (const c of counterparties) {
      if (myCounterparties.has(c.counterparty)) {
        shared.set(c.counterparty, (shared.get(c.counterparty) ?? 0) + 1);
      }
    }
  }
  return shared;
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

/** D5-H §64, §87: idempotent cluster persistence (replace per analysis). */
async function replaceClustersForAnalysis(
  sql: ProcessorContext["sql"],
  analysisId: string,
  walletId: string,
  clusters: Array<{ id: string; targetWallet: string; members: unknown; confidence: number; evidenceFamilies: string[]; limitations: string[]; engineVersion: string }>
): Promise<void> {
  if (clusters.length === 0) return;
  const repo = createRelationshipClusterRepo(sql);
  await repo.replaceForAnalysis(
    analysisId,
    walletId,
    clusters.map((c) => ({
      analysisId,
      walletId,
      clusterId: c.id,
      targetWallet: c.targetWallet,
      members: c.members,
      confidence: c.confidence,
      evidenceFamilies: c.evidenceFamilies,
      limitations: c.limitations,
      engineVersion: c.engineVersion
    }))
  );
}

export type { IntelligenceSignal, ScoreResult };
