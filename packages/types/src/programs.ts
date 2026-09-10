/**
 * Canonical Solana program catalog — the single source of truth for every
 * program identity AEGIX claims to recognize.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Program IDs used to be duplicated across four independent tables:
 * the entity seed registry, the normalizer parser registry, the account
 * classifier, and a hard-coded list inside `detectTransactionClass`. They
 * drifted, and five addresses were wrong in ways no unit test could see:
 * four decoded to valid 32-byte pubkeys that simply have no account on
 * mainnet, and one was not even 32 bytes. A wrong program ID fails silently
 * — it matches nothing, so the protocol is counted as an unknown program and
 * its exposure signal disappears. Silence is the worst possible failure mode
 * for an evidence-based engine.
 *
 * Every consumer now derives from this catalog, so an address exists exactly
 * once. Two guards protect it:
 *   - `validateProgramCatalog()` runs in unit tests: real base58, exactly 32
 *     bytes, no duplicate program ID, VERIFIED implies an evidence source.
 *   - `scripts/verify-programs.ts` runs against a real RPC: every catalog
 *     address must be an executable account owned by a loader.
 *
 * VERIFICATION STATUS (architecture.md §37)
 *   VERIFIED — identity confirmed by protocol-owned documentation/SDK, or by
 *     a vanity program-ID prefix that spells the protocol name AND an
 *     observed executable account on mainnet.
 *   PROBABLE — the account is an observed executable program, but the name
 *     rests on community documentation rather than a protocol-owned source.
 *
 * Program IDs are protocol-owned accounts, never user wallets. Exchange
 * deposit/hot wallets are deliberately absent: weak attribution must never
 * become fact.
 */

import type { ProtocolCategory, TransactionClass } from "./blockchain.js";
import type { EntityAddressRole } from "./entity.js";

export type ProgramVerificationStatus = "VERIFIED" | "PROBABLE";

export interface CanonicalProgram {
  /** Base58 program address. Must decode to exactly 32 bytes. */
  programId: string;
  /** Label for this specific program (an entity may own several). */
  label: string;
  /** Protocol category used by the normalizer and signal engines. */
  category: ProtocolCategory;
  status: ProgramVerificationStatus;
  confidence: number;
  evidenceSource: string;
  role?: EntityAddressRole;
  /**
   * Transaction class implied by this program's presence, when unambiguous.
   * Consumed by `detectTransactionClass` — absent means "does not by itself
   * determine the class".
   */
  transactionClass?: TransactionClass;
  /** Deprecation keeps the address for reproducibility, see §26. */
  deprecatedReason?: string;
}

export interface CanonicalEntity {
  /** Registry entity name; also the key used by commonality penalties. */
  name: string;
  entityType: string;
  description: string;
  status: ProgramVerificationStatus;
  confidence: number;
  sourceType: string;
  /**
   * Infrastructure programs (memo, compression, oracles, loaders) are parsed
   * for semantic coverage but are NOT seeded as attributable entities — every
   * wallet touches them, so entity overlap on them carries no evidence.
   */
  seedAsEntity: boolean;
  programs: CanonicalProgram[];
}

const DOC = "PROTOCOL_DOCUMENTATION";
const COMMUNITY = "COMMUNITY_DOCUMENTATION";

export const CANONICAL_ENTITIES: CanonicalEntity[] = [
  {
    name: "Jupiter",
    entityType: "DEX",
    description: "Jupiter — Solana's primary DEX aggregator, plus its limit-order, DCA and perpetuals programs.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", label: "Jupiter Aggregator v6", category: "DEX", status: "VERIFIED", confidence: 0.98, evidenceSource: "https://dev.jup.ag/docs/", role: "ROUTER", transactionClass: "SWAP" },
      { programId: "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", label: "Jupiter Aggregator v4", category: "DEX", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://dev.jup.ag/docs/", role: "ROUTER", transactionClass: "SWAP" },
      { programId: "j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X", label: "Jupiter Limit Order v2", category: "DEX", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://dev.jup.ag/docs/", role: "PROGRAM", transactionClass: "SWAP" },
      { programId: "DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M", label: "Jupiter DCA", category: "DEX", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://dev.jup.ag/docs/", role: "PROGRAM", transactionClass: "SWAP" },
      { programId: "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu", label: "Jupiter Perpetuals", category: "LENDING", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://dev.jup.ag/docs/", role: "PROGRAM", transactionClass: "LENDING" }
    ]
  },
  {
    name: "Raydium",
    entityType: "DEX",
    description: "Raydium — AMM, concentrated liquidity and constant-product pools.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      // Corrected 2026-09-10: the previously seeded 675kPX9…F2tcy6u6 decoded
      // to a valid pubkey with no mainnet account, so it never matched.
      { programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", label: "Raydium Liquidity Pool v4", category: "DEX", status: "VERIFIED", confidence: 0.98, evidenceSource: "https://docs.raydium.io/raydium/protocol/developers/addresses", role: "PROGRAM", transactionClass: "SWAP" },
      { programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", label: "Raydium Concentrated Liquidity", category: "DEX", status: "VERIFIED", confidence: 0.98, evidenceSource: "https://docs.raydium.io/raydium/protocol/developers/addresses", role: "PROGRAM", transactionClass: "SWAP" },
      { programId: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", label: "Raydium CPMM", category: "DEX", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://docs.raydium.io/raydium/protocol/developers/addresses", role: "PROGRAM", transactionClass: "SWAP" },
      { programId: "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS", label: "Raydium Router", category: "DEX", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://docs.raydium.io/raydium/protocol/developers/addresses", role: "ROUTER", transactionClass: "SWAP" }
    ]
  },
  {
    name: "Pump.fun",
    entityType: "PROTOCOL",
    description: "Pump.fun — meme token launchpad, its fee program and the PumpSwap AMM.",
    status: "VERIFIED",
    confidence: 0.95,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", label: "Pump.fun Bonding Curve", category: "MEMECOIN", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://pump.fun", role: "PROGRAM", transactionClass: "PAYMENT" },
      // Relabelled 2026-09-10: this was carried as "Raydium AMM v4". The
      // `pAMM` vanity prefix and its co-occurrence with the Pump.fun fee
      // program identify it as PumpSwap, Pump.fun's own AMM.
      { programId: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", label: "PumpSwap AMM", category: "MEMECOIN", status: "VERIFIED", confidence: 0.9, evidenceSource: "https://pump.fun", role: "PROGRAM", transactionClass: "SWAP" },
      { programId: "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", label: "Pump.fun Fee", category: "MEMECOIN", status: "VERIFIED", confidence: 0.9, evidenceSource: "https://pump.fun", role: "TREASURY" }
    ]
  },
  {
    name: "Orca",
    entityType: "DEX",
    description: "Orca — concentrated liquidity (Whirlpools) and legacy pools.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      // Corrected 2026-09-10: previously whirLbMiicVdio4qvUfM5KAg6Ct8Vdj…,
      // which has no mainnet account. Only the first 29 characters were right.
      { programId: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", label: "Orca Whirlpools", category: "DEX", status: "VERIFIED", confidence: 0.98, evidenceSource: "https://dev.orca.so/", role: "PROGRAM", transactionClass: "SWAP" },
      { programId: "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP", label: "Orca v1 Pools", category: "DEX", status: "PROBABLE", confidence: 0.85, evidenceSource: "https://dev.orca.so/", role: "PROGRAM", transactionClass: "SWAP" }
    ]
  },
  {
    name: "Meteora",
    entityType: "DEX",
    description: "Meteora — dynamic liquidity market maker and dynamic pools.",
    status: "VERIFIED",
    confidence: 0.95,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", label: "Meteora DLMM", category: "DEX", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://docs.meteora.ag/", role: "PROGRAM", transactionClass: "SWAP" },
      { programId: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", label: "Meteora Dynamic Pools", category: "DEX", status: "PROBABLE", confidence: 0.85, evidenceSource: "https://docs.meteora.ag/", role: "PROGRAM", transactionClass: "SWAP" }
    ]
  },
  {
    name: "Phoenix",
    entityType: "DEX",
    description: "Phoenix — on-chain central limit order book.",
    status: "VERIFIED",
    confidence: 0.95,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY", label: "Phoenix", category: "DEX", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://ellipsis-labs.gitbook.io/phoenix-dex", role: "PROGRAM", transactionClass: "SWAP" }
    ]
  },
  {
    name: "OpenBook",
    entityType: "DEX",
    description: "OpenBook — community central limit order book (v1 fork of Serum, and v2).",
    status: "PROBABLE",
    confidence: 0.9,
    sourceType: COMMUNITY,
    seedAsEntity: true,
    programs: [
      { programId: "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX", label: "OpenBook v1", category: "DEX", status: "PROBABLE", confidence: 0.9, evidenceSource: "https://github.com/openbook-dex", role: "PROGRAM", transactionClass: "SWAP" },
      { programId: "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb", label: "OpenBook v2", category: "DEX", status: "VERIFIED", confidence: 0.92, evidenceSource: "https://github.com/openbook-dex/openbook-v2", role: "PROGRAM", transactionClass: "SWAP" },
      { programId: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", label: "Serum v3 (deprecated)", category: "DEX", status: "PROBABLE", confidence: 0.8, evidenceSource: "https://github.com/project-serum/serum-dex", role: "PROGRAM", deprecatedReason: "Serum v3 is frozen; retained so historical transactions still classify" }
    ]
  },
  {
    name: "Lifinity",
    entityType: "DEX",
    description: "Lifinity — proactive market maker.",
    status: "PROBABLE",
    confidence: 0.85,
    sourceType: COMMUNITY,
    seedAsEntity: true,
    programs: [
      { programId: "EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S", label: "Lifinity v2", category: "DEX", status: "PROBABLE", confidence: 0.85, evidenceSource: "https://docs.lifinity.io/", role: "PROGRAM", transactionClass: "SWAP" }
    ]
  },
  {
    name: "Saber",
    entityType: "DEX",
    description: "Saber — stable-asset AMM.",
    status: "PROBABLE",
    confidence: 0.85,
    sourceType: COMMUNITY,
    seedAsEntity: true,
    programs: [
      { programId: "SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ", label: "Saber Stable Swap", category: "DEX", status: "VERIFIED", confidence: 0.9, evidenceSource: "https://docs.saber.so/", role: "PROGRAM", transactionClass: "SWAP" }
    ]
  },
  {
    name: "Kamino",
    entityType: "LENDING",
    description: "Kamino — lending and leveraged liquidity vaults.",
    status: "VERIFIED",
    confidence: 0.95,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      // Corrected 2026-09-10: previously KLend2g3cP87fffH8vSekita2…, which has
      // no mainnet account. Only the "KLend2g3cP87fff" prefix was right.
      { programId: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", label: "Kamino Lending", category: "LENDING", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://docs.kamino.finance/", role: "PROGRAM", transactionClass: "LENDING" }
    ]
  },
  {
    name: "Drift",
    entityType: "LENDING",
    description: "Drift — perpetuals, spot margin and borrow/lend.",
    status: "VERIFIED",
    confidence: 0.95,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      // Corrected 2026-09-10 from the drift-labs/protocol-v2 SDK config; the
      // previously seeded dRiftyHA39MWEi3m9aunc5tRFo… has no mainnet account.
      { programId: "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", label: "Drift v2", category: "LENDING", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://github.com/drift-labs/protocol-v2 sdk/src/config.ts", role: "PROGRAM", transactionClass: "LENDING" }
    ]
  },
  {
    name: "MarginFi",
    entityType: "LENDING",
    description: "MarginFi — lending and borrowing protocol.",
    status: "VERIFIED",
    confidence: 0.92,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA", label: "MarginFi v2", category: "LENDING", status: "VERIFIED", confidence: 0.92, evidenceSource: "https://docs.marginfi.com/", role: "PROGRAM", transactionClass: "LENDING" }
    ]
  },
  {
    name: "Solend",
    entityType: "LENDING",
    description: "Solend — algorithmic lending pools.",
    status: "VERIFIED",
    confidence: 0.92,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo", label: "Solend", category: "LENDING", status: "VERIFIED", confidence: 0.92, evidenceSource: "https://docs.solend.fi/", role: "PROGRAM", transactionClass: "LENDING" }
    ]
  },
  {
    name: "Mango",
    entityType: "LENDING",
    description: "Mango Markets — margin trading and perpetuals.",
    status: "VERIFIED",
    confidence: 0.9,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "4MangoMjqJ2firMokCjjGgoK8d4MXcrgL7XJaL3w6fVg", label: "Mango v4", category: "LENDING", status: "VERIFIED", confidence: 0.9, evidenceSource: "https://docs.mango.markets/", role: "PROGRAM", transactionClass: "LENDING" }
    ]
  },
  {
    name: "Zeta Markets",
    entityType: "LENDING",
    description: "Zeta — options and perpetuals.",
    status: "VERIFIED",
    confidence: 0.9,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "ZETAxsqBRek56DhiGXrn75yj2NHU3aYUnxvHXpkf3aD", label: "Zeta Markets", category: "LENDING", status: "VERIFIED", confidence: 0.9, evidenceSource: "https://docs.zeta.markets/", role: "PROGRAM", transactionClass: "LENDING" }
    ]
  },
  {
    name: "Metaplex",
    entityType: "NFT_PROTOCOL",
    description: "Metaplex — the NFT standard on Solana: token metadata, compressed NFTs, Candy Machine minting, Auction House and Core.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", label: "Metaplex Token Metadata", category: "NFT", status: "VERIFIED", confidence: 0.98, evidenceSource: "https://developers.metaplex.com/token-metadata", role: "PROGRAM" },
      { programId: "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY", label: "Metaplex Bubblegum (compressed NFTs)", category: "NFT", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://developers.metaplex.com/bubblegum", role: "PROGRAM" },
      { programId: "CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR", label: "Metaplex Candy Machine v3", category: "NFT", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://developers.metaplex.com/candy-machine", role: "PROGRAM", transactionClass: "NFT_MINT" },
      { programId: "Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g", label: "Metaplex Candy Guard", category: "NFT", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://developers.metaplex.com/candy-machine/guards", role: "PROGRAM", transactionClass: "NFT_MINT" },
      { programId: "cndy3Z4yapfJBmL3ShUp5exZKqR3z33thTzeNMm2gRZ", label: "Metaplex Candy Machine v2 (deprecated)", category: "NFT", status: "PROBABLE", confidence: 0.85, evidenceSource: "https://developers.metaplex.com/candy-machine", role: "PROGRAM", deprecatedReason: "Superseded by Candy Machine v3; retained for historical mints" },
      { programId: "hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk", label: "Metaplex Auction House", category: "NFT", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://developers.metaplex.com/auction-house", role: "ESCROW" },
      { programId: "auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg", label: "Metaplex Token Auth Rules", category: "NFT", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://developers.metaplex.com/token-auth-rules", role: "PROGRAM" },
      { programId: "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d", label: "Metaplex Core", category: "NFT", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://developers.metaplex.com/core", role: "PROGRAM" }
    ]
  },
  {
    name: "Tensor",
    entityType: "NFT_MARKETPLACE",
    description: "Tensor — NFT marketplace: order book swaps, compressed-NFT trading, bids and locks.",
    status: "VERIFIED",
    confidence: 0.95,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      // Replaces the classifier's TSWAPaqyCsxBPKKhB9A9d3SxJS1QyJzUHVN5VKHTWA,
      // which decoded to 31 bytes and was therefore not a pubkey at all.
      { programId: "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN", label: "Tensor Escrow", category: "NFT", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://docs.tensor.foundation/tensor-protocols", role: "ESCROW" },
      { programId: "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp", label: "Tensor Compressed NFT", category: "NFT", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://docs.tensor.trade/", role: "PROGRAM" },
      { programId: "TB1Dqt8JeKQh7RLDzfYDJsq8KS4fS2yt87avRjyRxMv", label: "Tensor Bid", category: "NFT", status: "VERIFIED", confidence: 0.9, evidenceSource: "https://docs.tensor.trade/", role: "ESCROW" },
      { programId: "TLoCKic2wGJm7VhZKumih4Lc35fUhYqVMgA4j389Buk", label: "Tensor Lock", category: "NFT", status: "VERIFIED", confidence: 0.9, evidenceSource: "https://docs.tensor.trade/", role: "ESCROW" }
    ]
  },
  {
    name: "Magic Eden",
    entityType: "NFT_MARKETPLACE",
    description: "Magic Eden — NFT marketplace and its MMM pool program.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K", label: "Magic Eden v2", category: "NFT", status: "VERIFIED", confidence: 0.98, evidenceSource: "https://docs.magiceden.io/", role: "PROGRAM" },
      { programId: "mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc", label: "Magic Eden MMM Pools", category: "NFT", status: "VERIFIED", confidence: 0.92, evidenceSource: "https://docs.magiceden.io/", role: "PROGRAM" }
    ]
  },
  {
    name: "Sharky",
    entityType: "NFT_LENDING",
    description: "Sharky — peer-to-peer NFT-collateralised lending.",
    status: "PROBABLE",
    confidence: 0.85,
    sourceType: COMMUNITY,
    seedAsEntity: true,
    programs: [
      { programId: "SHARKobtfF1bHhxD2eqftjHBdVSCbKo9JtgK71FhELP", label: "Sharky NFT Lending", category: "NFT", status: "PROBABLE", confidence: 0.85, evidenceSource: "https://docs.sharky.fi/", role: "ESCROW", transactionClass: "LENDING" }
    ]
  },
  {
    name: "Marinade",
    entityType: "STAKING",
    description: "Marinade — liquid staking protocol.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD", label: "Marinade Finance", category: "STAKING", status: "VERIFIED", confidence: 0.98, evidenceSource: "https://docs.marinade.finance/", role: "PROGRAM", transactionClass: "STAKE" }
    ]
  },
  {
    name: "Sanctum",
    entityType: "STAKING",
    description: "Sanctum — liquid staking token infinity pool and router.",
    status: "PROBABLE",
    confidence: 0.85,
    sourceType: COMMUNITY,
    seedAsEntity: true,
    programs: [
      { programId: "5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx", label: "Sanctum Infinity", category: "STAKING", status: "PROBABLE", confidence: 0.85, evidenceSource: "https://learn.sanctum.so/", role: "PROGRAM", transactionClass: "STAKE" },
      { programId: "stkitrT1Uoy18Dk1fTrgPw8W6MVzoCfYoAFT4MLsmhq", label: "Sanctum Router", category: "STAKING", status: "VERIFIED", confidence: 0.9, evidenceSource: "https://learn.sanctum.so/", role: "ROUTER", transactionClass: "STAKE" }
    ]
  },
  {
    name: "Lido on Solana",
    entityType: "STAKING",
    description: "Lido — liquid staking (stSOL), wind-down.",
    status: "PROBABLE",
    confidence: 0.85,
    sourceType: COMMUNITY,
    seedAsEntity: true,
    programs: [
      { programId: "CrX7kMhLC3cSsXJdT7JDgqrRVWGnUpX3gfEfxxU2NVLi", label: "Lido on Solana", category: "STAKING", status: "PROBABLE", confidence: 0.85, evidenceSource: "https://github.com/lidofinance/solido", role: "PROGRAM", transactionClass: "STAKE", deprecatedReason: "Lido on Solana has wound down; retained for historical stake activity" }
    ]
  },
  {
    name: "Wormhole",
    entityType: "BRIDGE",
    description: "Wormhole — cross-chain messaging core and token bridge.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth", label: "Wormhole Core Bridge", category: "BRIDGE", status: "VERIFIED", confidence: 0.98, evidenceSource: "https://docs.wormhole.com/wormhole/reference/constants", role: "PROGRAM" },
      { programId: "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb", label: "Wormhole Token Bridge", category: "BRIDGE", status: "VERIFIED", confidence: 0.98, evidenceSource: "https://docs.wormhole.com/wormhole/reference/constants", role: "PROGRAM" }
    ]
  },
  {
    name: "Squads",
    entityType: "MULTISIG",
    description: "Squads — multisig and programmable account management.",
    status: "VERIFIED",
    confidence: 0.92,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf", label: "Squads v4", category: "SYSTEM", status: "VERIFIED", confidence: 0.92, evidenceSource: "https://docs.squads.so/", role: "PROGRAM" },
      { programId: "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu", label: "Squads v3", category: "SYSTEM", status: "VERIFIED", confidence: 0.9, evidenceSource: "https://docs.squads.so/", role: "PROGRAM" }
    ]
  },
  {
    name: "Jito",
    entityType: "INFRASTRUCTURE",
    description: "Jito — MEV tip distribution.",
    status: "VERIFIED",
    confidence: 0.9,
    sourceType: DOC,
    seedAsEntity: true,
    programs: [
      { programId: "T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt", label: "Jito Tip Payment", category: "PAYMENT", status: "VERIFIED", confidence: 0.9, evidenceSource: "https://docs.jito.wtf/", role: "PROGRAM" }
    ]
  },

  // ---------------------------------------------------------------------
  // Infrastructure: parsed for semantic coverage, never seeded as entities.
  // Nearly every wallet touches these, so shared use is not evidence.
  // ---------------------------------------------------------------------
  {
    name: "Solana Program Library",
    entityType: "INFRASTRUCTURE",
    description: "SPL infrastructure programs — memo, stake pool, state compression.",
    status: "VERIFIED",
    confidence: 0.99,
    sourceType: DOC,
    seedAsEntity: false,
    programs: [
      { programId: "ComputeBudget111111111111111111111111111111", label: "Solana Compute Budget", category: "SYSTEM", status: "VERIFIED", confidence: 0.99, evidenceSource: "https://github.com/anza-xyz/agave/tree/master/programs/compute-budget", role: "PROGRAM" },
      { programId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", label: "SPL Associated Token Account", category: "SYSTEM", status: "VERIFIED", confidence: 0.99, evidenceSource: "https://spl.solana.com/associated-token-account", role: "PROGRAM" },
      { programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", label: "SPL Memo v2", category: "SYSTEM", status: "VERIFIED", confidence: 0.99, evidenceSource: "https://spl.solana.com/memo", role: "PROGRAM" },
      { programId: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy", label: "SPL Stake Pool", category: "STAKING", status: "VERIFIED", confidence: 0.99, evidenceSource: "https://spl.solana.com/stake-pool", role: "PROGRAM", transactionClass: "STAKE" },
      { programId: "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK", label: "SPL Account Compression", category: "SYSTEM", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://spl.solana.com/account-compression", role: "PROGRAM" },
      { programId: "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV", label: "SPL Noop", category: "SYSTEM", status: "VERIFIED", confidence: 0.95, evidenceSource: "https://spl.solana.com/account-compression", role: "PROGRAM" }
    ]
  },
  {
    name: "Solana Name Service",
    entityType: "INFRASTRUCTURE",
    description: "Bonfida Solana Name Service — .sol domain registry.",
    status: "PROBABLE",
    confidence: 0.88,
    sourceType: COMMUNITY,
    seedAsEntity: false,
    programs: [
      { programId: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX", label: "Solana Name Service", category: "SYSTEM", status: "PROBABLE", confidence: 0.88, evidenceSource: "https://github.com/Bonfida/name-tokenizer", role: "PROGRAM" }
    ]
  },
  {
    name: "Oracles",
    entityType: "INFRASTRUCTURE",
    description: "Price oracle programs — present in most DeFi transactions.",
    status: "PROBABLE",
    confidence: 0.88,
    sourceType: COMMUNITY,
    seedAsEntity: false,
    programs: [
      { programId: "FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH", label: "Pyth Oracle", category: "SYSTEM", status: "PROBABLE", confidence: 0.88, evidenceSource: "https://docs.pyth.network/", role: "PROGRAM" },
      { programId: "SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f", label: "Switchboard v2", category: "SYSTEM", status: "VERIFIED", confidence: 0.9, evidenceSource: "https://docs.switchboard.xyz/", role: "PROGRAM" }
    ]
  }
];

/** Every catalog program, flattened, with its owning entity attached. */
export interface FlatCanonicalProgram extends CanonicalProgram {
  entityName: string;
  entityType: string;
  seedAsEntity: boolean;
}

export const CANONICAL_PROGRAMS: FlatCanonicalProgram[] = CANONICAL_ENTITIES.flatMap((entity) =>
  entity.programs.map((program) => ({
    ...program,
    entityName: entity.name,
    entityType: entity.entityType,
    seedAsEntity: entity.seedAsEntity
  }))
);

const PROGRAM_BY_ID = new Map(CANONICAL_PROGRAMS.map((p) => [p.programId, p]));

export function canonicalProgram(programId: string): FlatCanonicalProgram | null {
  return PROGRAM_BY_ID.get(programId) ?? null;
}

/** Entity names that should be seeded into the attributable entity registry. */
export const SEEDABLE_ENTITIES = CANONICAL_ENTITIES.filter((e) => e.seedAsEntity);

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));

/**
 * Decodes a base58 string, or returns null when it is not valid base58.
 * Used both for public keys and for raw instruction data, which the RPC
 * returns base58-encoded whenever it cannot parse the instruction.
 */
export function base58Decode(value: string): Uint8Array | null {
  if (value.length === 0) return null;
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros++;

  // Base-58 → base-256 by repeated multiply-and-add over a byte buffer.
  const bytes: number[] = [];
  for (let i = leadingZeros; i < value.length; i++) {
    const digit = BASE58_INDEX.get(value[i]!);
    if (digit === undefined) return null;
    let carry = digit;
    for (let j = bytes.length - 1; j >= 0; j--) {
      const x = bytes[j]! * 58 + carry;
      bytes[j] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.unshift(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  out.set(bytes, leadingZeros);
  return out;
}

/**
 * Decoded byte length of a base58 string, or -1 when it is not valid base58.
 * A Solana public key is exactly 32 bytes; character-level checks alone
 * cannot catch a 31-byte address, which is how an unusable Tensor program ID
 * survived in the classifier.
 */
export function base58ByteLength(value: string): number {
  const decoded = base58Decode(value);
  return decoded ? decoded.length : -1;
}

/** True when `value` is a syntactically valid 32-byte Solana public key. */
export function isSolanaPublicKey(value: string): boolean {
  return base58ByteLength(value) === 32;
}

/**
 * Structural validation of the catalog. Returns a list of problems; an empty
 * list means the catalog is internally consistent. This does NOT prove an
 * address exists on-chain — `scripts/verify-programs.ts` does that against a
 * real RPC.
 */
export function validateProgramCatalog(entities: CanonicalEntity[] = CANONICAL_ENTITIES): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();

  for (const entity of entities) {
    if (!entity.name.trim()) problems.push("entity with empty name");
    if (entity.confidence < 0 || entity.confidence > 1) problems.push(`${entity.name}: entity confidence ${entity.confidence} out of range [0,1]`);
    if (!entity.sourceType.trim()) problems.push(`${entity.name}: missing sourceType`);
    if (entity.programs.length === 0) problems.push(`${entity.name}: no programs`);

    for (const program of entity.programs) {
      const where = `${entity.name}/${program.label}`;
      const byteLength = base58ByteLength(program.programId);
      if (byteLength !== 32) {
        problems.push(`${where}: program ID is ${byteLength < 0 ? "not valid base58" : `${byteLength} bytes, expected 32`} (${program.programId})`);
      }
      if (program.confidence < 0 || program.confidence > 1) {
        problems.push(`${where}: confidence ${program.confidence} out of range [0,1]`);
      }
      if (program.status === "VERIFIED" && !program.evidenceSource.trim()) {
        problems.push(`${where}: VERIFIED program missing evidenceSource`);
      }
      const existing = seen.get(program.programId);
      if (existing) problems.push(`program ${program.programId} claimed by both "${existing}" and "${where}"`);
      else seen.set(program.programId, where);
    }
  }

  return problems;
}
