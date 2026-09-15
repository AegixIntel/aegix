import bs58 from "bs58";

/** Ingestion capabilities are separate from the Solana-only privacy engine. */
export const CHAINS = {
  "solana:mainnet": { family: "solana", networkId: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", privacyAnalysis: true },
  "eip155:1": { family: "evm", networkId: "0x1", privacyAnalysis: false },
  "eip155:8453": { family: "evm", networkId: "0x2105", privacyAnalysis: false }
} as const;
export type NetworkChain = keyof typeof CHAINS;

export function parseChain(value: string): NetworkChain {
  if (!Object.hasOwn(CHAINS, value)) throw new Error("Unsupported ingestion chain");
  return value as NetworkChain;
}

export function walletIdentity(chain: NetworkChain, address: string): string {
  const spec = CHAINS[parseChain(chain)];
  if (spec.family === "evm") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Invalid EVM address");
    return `${chain}:${address.toLowerCase()}`;
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) || bs58.decode(address).length !== 32) {
    throw new Error("Invalid Solana address");
  }
  return `${chain}:${address}`;
}
