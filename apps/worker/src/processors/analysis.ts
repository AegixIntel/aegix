import type { Job } from "bullmq";
import type { AppConfig } from "@aegix/config";
import type { BlockchainProvider, RawTransaction } from "@aegix/blockchain";
import { SolanaRpcProvider } from "@aegix/blockchain";
import { createDb, createAnalysisJobRepo, createWalletAnalyticsRepo, createWalletRepo } from "@aegix/database";
import { normalizeTransaction } from "@aegix/normalizer";
import type { NormalizedTransaction, WalletRelationship } from "@aegix/types";
import {
  analyzeBehavior,
  analyzeClusters,
  analyzeCounterparties,
  analyzeEntities,
  analyzeFunding,
  type EntityRegistry
} from "@aegix/intelligence";
import { scoreWallet } from "@aegix/scoring";
import { annotateEntities, buildGraph, findExposurePaths } from "@aegix/graph";
import type { AnalysisJobData } from "@aegix/queue";
import type { ProcessorContext } from "../worker.js";

const EMPTY_ENTITY_REGISTRY: EntityRegistry = { entities: [], addresses: [] };

/**
 * Full wallet analysis pipeline, see architecture.md §140.
 * fetch -> normalize -> engines -> score -> paths -> persist.
 */
export async function processAnalysis(job: Job<AnalysisJobData>, ctx: ProcessorContext): Promise<void> {
  const { config } = ctx;
  const { analysisId, walletAddress, chain } = job.data;
  const sql = ctx.sql;

  const jobRepo = createAnalysisJobRepo(sql);
  const walletRepo = createWalletRepo(sql);
  const analyticsRepo = createWalletAnalyticsRepo(sql);

  const provider = new SolanaRpcProvider({ RPC_URL: config.RPC_URL, RPC_WEBSOCKET_URL: config.RPC_WEBSOCKET_URL });

  try {
    await jobRepo.markStarted(analysisId, "aegix-pipeline-v1.0.0");
    await jobRepo.updateStatus(analysisId, "FETCHING", 10);

    const wallet = await walletRepo.findOrCreate(chain, walletAddress);

    // 1. Fetch signatures
    const signatures = await fetchSignatures(provider, walletAddress, config);
    if (signatures.length === 0) {
      await jobRepo.markFailed(analysisId, "INSUFFICIENT_HISTORY", "No activity found for wallet");
      return;
    }
    await jobRepo.updateStatus(analysisId, "NORMALIZING", 30);

    // 2. Fetch + normalize transactions (bounded)
    const transactions: NormalizedTransaction[] = [];
    const txBudget = config.ANALYSIS_MAX_TRANSACTIONS;
    for (const sig of signatures) {
      if (transactions.length >= txBudget) break;
      const raw = await provider.getTransaction(sig.signature);
      if (!raw) continue;
      const normalized = normalizeTransaction({
        signature: sig.signature,
        raw: raw.json as never,
        walletAddress,
        rawProvider: provider.name
      });
      transactions.push(normalized.transaction);
    }

    if (transactions.length === 0) {
      await jobRepo.markFailed(analysisId, "CHAIN_DATA_UNAVAILABLE", "No parseable transactions found");
      return;
    }
    await jobRepo.updateStatus(analysisId, "ENTITY_ANALYSIS", 45);

    // 3. Persist normalized data
    for (const tx of transactions) {
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
      if (row.id) {
        await analyticsRepo.insertTransfers(
          tx.transfers.map((t) => ({
            transaction_id: row.id,
            from_address: t.fromAddress,
            to_address: t.toAddress,
            asset_type: t.assetType,
            mint: t.mint,
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
            program_label: ix.programLabel,
            protocol_category: ix.protocolCategory,
            action_type: ix.actionType,
            block_time: ix.blockTime
          }))
        );
      }
    }

    // 4. Run intelligence engines
    const allTransfers = transactions.flatMap((t) => t.transfers);
    const allInteractions = transactions.flatMap((t) => t.programInteractions);

    const funding = analyzeFunding({ walletAddress, transfers: allTransfers });
    const counterparty = analyzeCounterparties({ walletAddress, transfers: allTransfers });
    const behavior = analyzeBehavior({
      walletAddress,
      transactions,
      interactions: allInteractions
    });
    const entities = analyzeEntities({
      walletAddress,
      transfers: allTransfers,
      interactions: allInteractions,
      registry: EMPTY_ENTITY_REGISTRY
    });
    const clusters = analyzeClusters({
      walletAddress,
      transfers: allTransfers,
      sharedCounterparties: new Map()
    });

    await jobRepo.updateStatus(analysisId, "SCORING", 70);

    // 5. Score
    const historyStart = transactions[transactions.length - 1]?.blockTime;
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
      parserFailures: 0,
      transactionsRequested: signatures.length,
      transactionsReceived: transactions.length
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

    await jobRepo.updateStatus(analysisId, "PERSISTING", 95);

    // 7. Mark complete with freshness + data quality
    const chainDataUntil = new Date().toISOString();
    await jobRepo.markCompleted(
      analysisId,
      {
        chainDataUntil,
        freshUntil: new Date(Date.now() + config.ANALYSIS_CACHE_TTL_SECONDS * 1000).toISOString()
      },
      {
        transactionsRequested: signatures.length,
        transactionsReceived: transactions.length,
        transactionsParsed: transactions.length,
        parserFailures: 0,
        historyStart: historyStart ?? null,
        historyEnd: chainDataUntil,
        providerFailures: 0
      }
    );

    job.log(`analysis ${analysisId} complete: ${transactions.length} tx, score ${score.overallScore}, ${pathResult.paths.length} paths`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await jobRepo.markFailed(analysisId, "INTERNAL_ERROR", message.slice(0, 500));
    throw err;
  }
}

async function fetchSignatures(provider: BlockchainProvider, address: string, config: AppConfig): Promise<Array<{ signature: string; slot: number }>> {
  const sigs = await provider.getSignatures(address, { limit: Math.min(config.ANALYSIS_MAX_TRANSACTIONS, 1000) });
  return sigs.filter((s) => s.blockTime != null).map((s) => ({ signature: s.signature, slot: s.slot }));
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
        strengthScore: 0.35,
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
