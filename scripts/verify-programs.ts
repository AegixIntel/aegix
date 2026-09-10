/**
 * Live verification of the canonical Solana program catalog.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * Verification is layered, and the layers are different claims:
 *
 *   STRUCTURALLY_VALID   base58 that decodes to exactly 32 bytes
 *   MAINNET_PRESENT      an account exists at that address
 *   EXECUTABLE_PROGRAM   account.executable === true
 *   LOADER_VALID         the account is owned by a Solana program loader
 *   PROTOCOL_ATTRIBUTION evidence that this program belongs to the protocol
 *                        AEGIX names it as
 *
 * This script proves the first four. It CANNOT prove the fifth: an executable,
 * loader-owned account is a deployed program, not proof of whose program it
 * is. Attribution evidence lives per-entry in `evidenceSource` and is
 * summarised in `docs/program-catalog.md`; a green run here must never be read
 * as "protocol identity confirmed".
 *
 * The layer it exists for is MAINNET_PRESENT. The structural test in
 * `packages/types/src/programs.test.ts` cannot reach it, and four seeded
 * protocol addresses once passed every structural check while pointing at
 * accounts that have never existed on mainnet — so the protocols they named
 * were silently counted as unknown programs.
 *
 * FAILURE SEMANTICS
 * -----------------
 * A catalog defect and an RPC outage must never be confused. An unreachable or
 * malformed RPC exits 2 and reports nothing about the catalog; only a real
 * account-level defect exits 1. Both are non-zero, so the release gate blocks
 * either way, but the operator can tell them apart.
 *
 * All access is read-only public chain data. Requests are batched, bounded by
 * a per-request timeout and a fixed retry budget.
 *
 * Usage: RPC_URL=<mainnet endpoint> pnpm verify:programs
 */

import { CANONICAL_PROGRAMS, validateProgramCatalog, type FlatCanonicalProgram } from "@aegix/types";

const RPC_URL = process.env.RPC_URL ?? process.env.RPC_PRIMARY_URL;

/** Exit codes, so a release gate can distinguish the two failure modes. */
const EXIT_CATALOG_DEFECT = 1;
const EXIT_RPC_FAULT = 2;

const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 4;
const BETWEEN_BATCHES_MS = 200;

/** Accounts owned by one of these are genuine deployed programs. */
const LOADERS = new Set([
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  "NativeLoader1111111111111111111111111111111"
]);

interface AccountValue {
  executable: boolean;
  owner: string;
}

/** Raised when the endpoint, not the catalog, is the problem. */
class RpcFault extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches account metadata for one batch.
 *
 * `dataSlice` keeps responses small: a non-upgradeable program account holds
 * its whole ELF, which can otherwise exceed the response size limit and make
 * a healthy program look absent.
 *
 * Throws RpcFault — never returns a partial result — so a transport problem
 * can never be mistaken for a missing account.
 */
async function fetchBatch(addresses: string[]): Promise<Array<AccountValue | null>> {
  let lastFault = "unknown";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(RPC_URL!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getMultipleAccounts",
          params: [addresses, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "finalized" }]
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (response.status === 429 || response.status >= 500) {
        lastFault = `HTTP ${response.status}`;
        await sleep(1000 * attempt);
        continue;
      }
      if (!response.ok) throw new RpcFault(`HTTP ${response.status}`);

      const json = (await response.json()) as { result?: { value?: unknown }; error?: { message?: string } };

      if (json.error) {
        const message = json.error.message ?? "unspecified RPC error";
        if (/rate|limit|busy|timeout|unavailable/i.test(message)) {
          lastFault = message;
          await sleep(1000 * attempt);
          continue;
        }
        throw new RpcFault(message);
      }

      const value = json.result?.value;
      // A short or missing array is a malformed response, NOT a batch of
      // missing accounts. Reporting it per-address would flag every program in
      // the batch as invalid during an endpoint hiccup.
      if (!Array.isArray(value)) throw new RpcFault("response has no result.value array");
      if (value.length !== addresses.length) {
        throw new RpcFault(`response covered ${value.length} of ${addresses.length} requested addresses`);
      }

      return value as Array<AccountValue | null>;
    } catch (err) {
      if (err instanceof RpcFault) throw err;
      lastFault = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(1000 * attempt);
    }
  }

  throw new RpcFault(`no usable response after ${MAX_ATTEMPTS} attempts (${lastFault})`);
}

function inspect(program: FlatCanonicalProgram, account: AccountValue | null): string | null {
  const where = `${program.entityName}/${program.label}`;
  if (!account) {
    return `${where}: MAINNET_PRESENT failed — no account at ${program.programId}; this address matches nothing on-chain`;
  }
  if (!account.executable) {
    return `${where}: EXECUTABLE_PROGRAM failed — ${program.programId} exists but is not executable (owner ${account.owner})`;
  }
  if (!LOADERS.has(account.owner)) {
    return `${where}: LOADER_VALID failed — ${program.programId} is executable but owned by ${account.owner}, not a known loader`;
  }
  return null;
}

async function run(): Promise<void> {
  const structural = validateProgramCatalog();
  if (structural.length > 0) {
    console.error("STRUCTURALLY_VALID failed:");
    for (const problem of structural) console.error(`  - ${problem}`);
    process.exitCode = EXIT_CATALOG_DEFECT;
    return;
  }

  if (!RPC_URL) {
    console.error("RPC_URL (or RPC_PRIMARY_URL) is required for live program verification");
    process.exitCode = EXIT_RPC_FAULT;
    return;
  }

  const failures: string[] = [];
  let checked = 0;

  for (let i = 0; i < CANONICAL_PROGRAMS.length; i += BATCH_SIZE) {
    const batch = CANONICAL_PROGRAMS.slice(i, i + BATCH_SIZE);
    let accounts: Array<AccountValue | null>;
    try {
      accounts = await fetchBatch(batch.map((p) => p.programId));
    } catch (err) {
      // Deliberately says nothing about the catalog: an unreachable endpoint
      // is not evidence that any program address is wrong.
      console.error(`RPC FAULT — catalog NOT verified: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`  ${checked} of ${CANONICAL_PROGRAMS.length} programs were checked before the fault.`);
      process.exitCode = EXIT_RPC_FAULT;
      return;
    }

    batch.forEach((program, index) => {
      checked += 1;
      const failure = inspect(program, accounts[index] ?? null);
      if (failure) failures.push(failure);
    });
    await sleep(BETWEEN_BATCHES_MS);
  }

  if (failures.length > 0) {
    console.error(`CATALOG DEFECT — ${failures.length} of ${checked} programs failed verification:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = EXIT_CATALOG_DEFECT;
    return;
  }

  console.log(`verified ${checked} catalog programs: MAINNET_PRESENT, EXECUTABLE_PROGRAM and LOADER_VALID all hold.`);
  console.log("This does not establish PROTOCOL_ATTRIBUTION — see evidenceSource per entry and docs/program-catalog.md.");
}

run().catch((err) => {
  console.error(`RPC FAULT — catalog NOT verified: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = EXIT_RPC_FAULT;
});
