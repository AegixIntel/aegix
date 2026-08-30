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
import { createDb, createAnalysisJobRepo, createWalletRepo } from "@aegix/database";
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
 */
const GOLDEN_WALLETS: GoldenWallet[] = [
  { category: "NEW_WALLET", address: "H4CpqxDhB2WLq43snohnKRwBEGm7XENdz8PU1cUfQm2a", note: "fresh keypair, zero activity" },
  { category: "TOKEN_MINT", address: "So11111111111111111111111111111111111111112", note: "Wrapped SOL mint, very high activity" },
  { category: "SYSTEM_ACCOUNT", address: "SysvarC1ock11111111111111111111111111111111", note: "clock sysvar, system traffic" },
  { category: "PROTOCOL_ACCOUNT", address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", note: "Jupiter v6 program id" }
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
      results.push({
        category: wallet.category,
        status: final?.status ?? "UNKNOWN",
        durationSec,
        transactionsParsed: (dq.transactionsParsed as number) ?? 0,
        parserFailures: (dq.parserFailures as number) ?? 0,
        rpcFailures: (dq.rpcFailures as number) ?? 0,
        historyDays: (dq.historyEnd && dq.historyStart
          ? Math.round((new Date(dq.historyEnd as string).getTime() - new Date(dq.historyStart as string).getTime()) / 86_400_000)
          : 0) as number,
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
