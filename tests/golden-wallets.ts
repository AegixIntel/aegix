/**
 * Golden wallet test runner, see architecture.md §94 and milestone Phase 10.
 *
 * Runs the full analysis pipeline against real Solana mainnet for a curated
 * set of wallet categories and prints a comparison-friendly summary.
 *
 * Usage: pnpm test:wallets
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
 * Wallet set. Categories intentionally include edge cases:
 * - NEW_WALLET: fresh keypair, no activity
 * - SYSTEM_ACCOUNT: program-owned system addresses with heavy activity
 * - TOKEN_MINT: SPL mint address (So111 Wrapped SOL)
 * - PROTOCOL_ACCOUNT: known protocol program id
 * - USER_*: real active wallets (public protocol/system accounts only)
 */
const GOLDEN_WALLETS: GoldenWallet[] = [
  { category: "NEW_WALLET", address: "H4CpqxDhB2WLq43snohnKRwBEGm7XENdz8PU1cUfQm2a", note: "fresh keypair, zero activity" },
  { category: "TOKEN_MINT", address: "So11111111111111111111111111111111111111112", note: "Wrapped SOL mint, very high activity" },
  { category: "SYSTEM_ACCOUNT", address: "SysvarC1ock11111111111111111111111111111111", note: "clock sysvar, system traffic" },
  { category: "PROTOCOL_ACCOUNT", address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", note: "Jupiter v6 program id" },
  { category: "DEX_HEAVY", address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wF2tcy6u6", note: "Raydium AMM program" },
  { category: "DEX_HEAVY", address: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", note: "Raydium CLMM program" },
  { category: "DEX_HEAVY", address: "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP", note: "Orca v1 program" },
  { category: "DEX_HEAVY", address: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", note: "Meteora DLMM program" },
  { category: "DEFI_HEAVY", address: "KLend2g3cP87fffH8vSekita2WqbcjYb75QHoWJvEPw", note: "Kamino lending program" },
  { category: "DEFI_HEAVY", address: "dRiftyHA39MWEi3m9aunc5tRFoFjCjFQ5uMYFnMqdfF", note: "Drift program" },
  { category: "NFT_HEAVY", address: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", note: "Metaplex Token Metadata program" },
  { category: "STAKING", address: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD", note: "Marinade liquid staking program" },
  { category: "BRIDGE", address: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth", note: "Wormhole bridge program" },
  { category: "MEMECOIN", address: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", note: "Pump.fun launchpad program" },
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
  const logger = createLogger(config, { service: "golden-wallets" });

  const results: Array<Record<string, string | number | null>> = [];

  for (const wallet of GOLDEN_WALLETS) {
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

      // Snapshot: pull signal/score/path/entity summary for regression (Phase 22).
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

  await cacheRelease();
  async function cacheRelease(): Promise<void> {
    // cache is fire-and-forget in this script
  }
  await sql.end();
}

run().catch((err) => {
  console.error("golden wallet run failed:", err);
  process.exitCode = 1;
});
