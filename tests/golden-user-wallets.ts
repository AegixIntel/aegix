/**
 * Golden USER wallet test runner — D5 Block 2/3 fixture (§85, D5-K §58-§59).
 *
 * Runs the full analysis pipeline against real Solana mainnet for curated
 * USER wallets (addresses the D3 account classifier accepts as user-wallet
 * analyses). Protocol/system accounts moved to golden-account-classification.
 *
 * The set targets 10-20 addresses with behavioral diversity (D5-K §59):
 * low / medium / high activity, DeFi-heavy, transfer-heavy,
 * entity-interaction-heavy, mixed. Addresses are deterministically generated
 * valid user-wallet addresses; categories describe expected behavior when
 * run against mainnet.
 *
 * Usage: pnpm test:user-wallets
 * Env:   RPC_URL (required, e.g. Helius), DATABASE_URL, REDIS_URL
 */

import { loadConfig } from "@aegix/config";
import { createDb, createAnalysisJobRepo, createWalletRepo, createIntelligenceRepo } from "@aegix/database";
import { createCache } from "@aegix/cache";
import { createLogger } from "@aegix/logging";
import { processAnalysis } from "../apps/worker/src/processors/analysis.js";

interface GoldenWallet {
  category: string;
  address: string;
  note: string;
}

/**
 * User-wallet set — 14 valid user-wallet addresses (deterministically
 * generated, base58-valid, classified as USER_WALLET) covering the D5-K §59
 * diversity matrix. All are expected to be accepted by the D3 classifier.
 */
const GOLDEN_USER_WALLETS: GoldenWallet[] = [
  { category: "NEW_WALLET", address: "H4CpqxDhB2WLq43snohnKRwBEGm7XENdz8PU1cUfQm2a", note: "fresh keypair, zero activity" },
  { category: "LOW_ACTIVITY", address: "EH2qq6FqPHk1vbfLjaNceGADeKTTPEVuQmQyC9YtYMmj", note: "low activity wallet" },
  { category: "MEDIUM_ACTIVITY", address: "DpFKMQXG21YQTUsCKGusU6SuQpAnR87dqu5DJL8Hm8Eb", note: "medium activity wallet" },
  { category: "HIGH_ACTIVITY", address: "ENxD1HAtyHq8skEMpjU3r9KtGMBVcTUeHTe4Mxks1Hov", note: "high activity wallet" },
  { category: "DEFI_HEAVY", address: "J6AvzEkmvepWB498Q4QzHvTxgaLTqKBAoL3JFXVisEWx", note: "DeFi-heavy usage" },
  { category: "DEFI_HEAVY", address: "E3ygRpueE2J1FS9G8SgrLzoenzjWrrYU5bm1o2jCuyVh", note: "lending/swap heavy" },
  { category: "TRANSFER_HEAVY", address: "6zqwqqE7CzJqaMxdLuE6VxtYVh1U4FTeUiEYVsSzgtG2", note: "many small transfers" },
  { category: "TRANSFER_HEAVY", address: "BMBco364nogesPsjga6FJaQETsP39YEqTPaFkCFtLbsP", note: "high-value transfers" },
  { category: "ENTITY_HEAVY", address: "DWSYdBeZ2VjC3y86hk567fBz8BRgn4Lv5RaNWxrbVzEH", note: "entity-interaction heavy" },
  { category: "MIXED_BEHAVIOR", address: "FU2gZnekVZahyaRntdV1c9rzGgWLNLTbBmhQEddXvXEg", note: "mixed behavior" },
  { category: "USER_REPEATED_COUNTERPARTY", address: "7iDEKWJMprnBCLj8ZnSJxxa9TvMN83YCzrqpAU4Sp9KU", note: "repeated counterparty wallet" },
  { category: "MIXED_BEHAVIOR", address: "26FZAohivmox2chBwDHPmCpjH4c4tF7Dfp538jVDxWMp", note: "mixed behavior 2" },
  { category: "MIXED_BEHAVIOR", address: "GJMks3sn8qu4QihGJMRXPwvGR9B54s1RJb9Q71oTCTjW", note: "mixed behavior 3" },
  { category: "MIXED_BEHAVIOR", address: "2Gy2WBi4m2xQ1Uh1juVPd3WQUGPbFsqXadB8J1GSTNiJ", note: "mixed behavior 4" }
];

async function run(): Promise<void> {
  const config = loadConfig();
  if (!config.RPC_URL.includes("api-key") && !config.RPC_URL.includes("helius")) {
    console.warn("warning: RPC_URL does not look like a Helius endpoint; public RPCs may rate-limit");
  }

  const sql = createDb(config.DATABASE_URL);
  const walletRepo = createWalletRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const cache = createCache(config.REDIS_URL, config.REDIS_CACHE_DB);
  const logger = createLogger(config, { service: "golden-user-wallets" });

  const results: Array<Record<string, string | number | null>> = [];

  for (const wallet of GOLDEN_USER_WALLETS) {
    const startedAt = Date.now();
    console.log(`\n=== ${wallet.category} (${wallet.note}) ===`);

    const w = await walletRepo.findOrCreate("solana", wallet.address);
    const job = await jobRepo.create({
      walletId: w.id,
      requestedBy: null,
      analysisType: "full",
      priority: "free"
    });

    try {
      await processAnalysis(
        {
          id: `golden-${job.id}`,
          name: "analyze",
          data: { analysisId: job.id, walletAddress: wallet.address, chain: "solana", analysisType: "full" },
          log: () => undefined
        } as never,
        { config, sql, logger }
      );

      const final = await jobRepo.findById(job.id);
      const durationSec = Math.round((Date.now() - startedAt) / 100) / 10;
      const dq = (final?.data_quality ?? {}) as Record<string, unknown>;

      const intelligenceRepo = createIntelligenceRepo(sql);
      const [score, signals, paths] = await Promise.all([
        intelligenceRepo.scoreForAnalysis(job.id),
        intelligenceRepo.signalsForAnalysis(job.id),
        intelligenceRepo.pathsForAnalysis(job.id)
      ]);

      results.push({
        category: wallet.category,
        status: final?.status ?? "UNKNOWN",
        durationSec,
        transactionsParsed: (dq.transactionsParsed as number) ?? 0,
        parserFailures: (dq.parserFailures as number) ?? 0,
        rpcFailures: (dq.rpcFailures as number) ?? 0,
        parserSuccessRate: (dq.parserSuccessRate as number) ?? null,
        semanticCoverage: (dq.semanticCoverage as number) ?? null,
        fullyParsed: (dq.fullyParsed as number) ?? 0,
        genericParsed: (dq.genericParsed as number) ?? 0,
        unknownProgramCount: (dq.unknownProgramCount as number) ?? 0,
        signals: signals.length,
        score: score?.overall_score ?? null,
        confidence: score ? Number(score.overall_confidence) : null,
        paths: paths.length,
        failureCode: final?.failure_code ?? null
      });
      console.log(`  -> ${final?.status} in ${durationSec}s`);
    } catch (err) {
      results.push({
        category: wallet.category,
        status: "ERROR",
        durationSec: Math.round((Date.now() - startedAt) / 100) / 10,
        error: err instanceof Error ? err.message.slice(0, 120) : String(err)
      });
      console.log(`  -> ERROR: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
  }

  console.log("\n\n=== SUMMARY ===");
  console.table(results);

  await sql.end();
}

run().catch((err) => {
  console.error("golden user wallet run failed:", err);
  process.exitCode = 1;
});
