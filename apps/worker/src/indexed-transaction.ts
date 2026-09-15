import type { BlockchainProvider, RawTransaction } from "@aegix/blockchain";

/** Reuse parsed finalized records; retain RPC fallback for gaps and old raw JSON. */
export async function getIndexedTransaction(
  signature: string, provider: BlockchainProvider,
  lookup?: (signature: string) => Promise<unknown>
): Promise<{ transaction: RawTransaction | null; source: string }> {
  if (lookup) {
    try {
      const value = await lookup(signature) as {
        slot?: number; blockTime?: number | null;
        transaction?: { signatures?: string[]; message?: { accountKeys?: Array<{ pubkey?: string } | string> } }
      } | null;
      const keys = value?.transaction?.message?.accountKeys;
      if (value && Number.isSafeInteger(value.slot) && value.transaction?.signatures?.[0] === signature &&
        keys?.length && keys.every(key => typeof key === "object" && typeof key.pubkey === "string")) {
        return { transaction: { signature, slot: value.slot!, blockTime: value.blockTime ?? null, json: value }, source: "aegix-finalized-index" };
      }
    } catch { /* Index unavailability must not prevent existing RPC analysis. */ }
  }
  return { transaction: await provider.getTransaction(signature), source: provider.name };
}
