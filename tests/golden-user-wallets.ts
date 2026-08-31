/**
 * Golden USER wallet test runner — D5 Block 2 fixture split (§85).
 *
 * Runs the full analysis pipeline against real Solana mainnet for curated
 * USER wallets (addresses the D3 account classifier accepts as user-wallet
 * analyses). Protocol/system accounts moved to golden-account-classification.
 *
 * Usage: pnpm test:user-wallets
 * Env:   RPC_URL (required, e.g. Helius), DATABASE_URL, REDIS_URL
 *
 * The wallet addresses here are public, well-known protocol/system accounts
 * or freshly generated test wallets — no personal attribution.
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
 * User-wallet set. All addresses are expected to be classified as USER
 * wallets by the D3 account classifier (fresh keypair or user-controlled
 * accounts with real activity).
 */
const GOLDEN_USER_WALLETS: GoldenWallet[] = [
  { category: "NEW_WALLET", address: "H4CpqxDhB2WLq43snohnKRwBEGm7XENdz8PU1cUfQm2a", note: "fresh keypair, zero activity" },
  { category: "USER_REPEATED_COUNTERPARTY", address: "7iDEKWJMprnBCLj8ZnSJxxa9TvMN83YCzrqpAU4Sp9KU", note: "repeated counterparty wallet" }
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
