/**
 * Protocol parser registry.
 *
 * Program identity (address, label, category) comes from the canonical
 * catalog in `@aegix/types` — this file only adds the instruction → action
 * semantics. Addresses are never written here, because duplicating them is
 * what let four protocol program IDs rot into addresses that matched nothing.
 *
 * Three matching strategies, tried in order:
 *   1. `actions`       — `instruction.parsed.type`, for the few programs the
 *                        RPC parses natively (System, SPL Token, Stake).
 *   2. `anchorActions` — Anchor 8-byte discriminators derived from method
 *                        names. Many of these names were confirmed by
 *                        observing their computed discriminator in real
 *                        mainnet instruction data; the rest are plausible
 *                        names that have not been observed. That asymmetry is
 *                        safe: the discriminator is a one-way digest of the
 *                        name, so a WRONG name produces bytes that match
 *                        nothing. An unobserved Anchor name can therefore
 *                        only fail to add coverage — it can never invent an
 *                        action. Do not read this list as a verified
 *                        instruction inventory for any protocol.
 *   3. `byteActions`   — Shank single-u8 instruction index. This carries the
 *                        opposite risk: byte 49 means something for every
 *                        program, so a wrong index INVENTS an action. These
 *                        maps are therefore held to observation, and the
 *                        admission rule is stated at each map.
 *
 * `fallbackAction` is deliberately rare. `semanticCoverage` is the share of
 * instructions whose semantics were actually understood, and it caps the
 * confidence AEGIX reports — so handing every program a generic fallback
 * would drive coverage toward 1.0 and make the engine MORE confident about
 * data it understands LESS. A fallback is therefore only allowed where the
 * program does exactly one thing (memo, fee, tip, oracle update, auth-rule
 * check) or where it is long-established behaviour (Token Metadata, Magic
 * Eden v2). Everywhere else an unmatched instruction returns null and the
 * transaction is honestly counted as PARTIALLY_PARSED. The interaction row is
 * still written either way, carrying the program label and protocol category,
 * so protocol attribution never depends on the fallback.
 */

import { CANONICAL_PROGRAMS, type ProtocolCategory } from "@aegix/types";
import type { ParsedInstruction, ProgramParser } from "../types.js";
import { buildAnchorLookup, matchAnchorAction, matchByteAction } from "./anchor.js";

export interface ProtocolParserDefinition {
  programId: string;
  label: string;
  category: ProtocolCategory;
  /** Actions keyed by RPC-parsed instruction type. */
  actions: Record<string, string>;
  /** Actions keyed by Anchor method name (discriminator computed at load). */
  anchorActions?: Record<string, string>;
  /** Actions keyed by Shank u8 instruction index. */
  byteActions?: Record<number, string>;
  /** Action used when the program is recognized but the instruction is not. */
  fallbackAction?: string;
}

/** Instruction semantics per program ID. Identity lives in the catalog. */
interface ActionSemantics {
  actions?: Record<string, string>;
  anchorActions?: Record<string, string>;
  byteActions?: Record<number, string>;
  fallbackAction?: string;
}

const SWAP_ACTIONS: Record<string, string> = {
  swap: "SWAP",
  routeSwap: "SWAP",
  routeSwapV2: "SWAP",
  sharedAccountsExactOutRoute: "SWAP",
  initialize: "INITIALIZE",
  initializePool: "INITIALIZE",
  createPool: "CREATE_POOL",
  deposit: "DEPOSIT",
  withdraw: "WITHDRAW",
  addLiquidity: "ADD_LIQUIDITY",
  removeLiquidity: "REMOVE_LIQUIDITY"
};

const LENDING_ACTIONS: Record<string, string> = {
  deposit: "DEPOSIT",
  withdraw: "WITHDRAW",
  borrow: "BORROW",
  repay: "REPAY",
  liquidate: "LIQUIDATE",
  placeOrder: "PLACE_ORDER"
};

const SEMANTICS: Record<string, ActionSemantics> = {
  // ---------------- DEX / aggregators ----------------
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: {
    actions: SWAP_ACTIONS,
    anchorActions: {
      route: "SWAP",
      route_with_token_ledger: "SWAP",
      shared_accounts_route: "SWAP",
      shared_accounts_route_with_token_ledger: "SWAP",
      exact_out_route: "SWAP",
      shared_accounts_exact_out_route: "SWAP",
      set_token_ledger: "SET_TOKEN_LEDGER"
    }
  },
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: { actions: SWAP_ACTIONS },
  j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X: { actions: SWAP_ACTIONS },
  DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M: { actions: SWAP_ACTIONS },
  PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu: { actions: LENDING_ACTIONS },
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": {
    actions: SWAP_ACTIONS,
    // Raydium AMM v4 is not an Anchor program: it prefixes instructions with a
    // single u8 index. Only the two indices confirmed on mainnet are mapped —
    // each nests exactly two SPL transfers (tokens in, tokens out) under a
    // 17-byte instruction, which is the swap layout. A wrong u8 mapping would
    // invent an action, unlike a wrong Anchor method name, so the rest are
    // left unmapped.
    // Tag 16 (SwapBaseInV2) is pinned by raydium-amm commit d26944b and was
    // observed in five finalized mainnet transactions on 2026-09-11.
    byteActions: { 9: "SWAP", 11: "SWAP", 16: "SWAP" }
  },
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: {
    actions: SWAP_ACTIONS,
    // raydium-clmm commit ed7c84a; `swap_v2` was observed six times in the
    // bounded 2026-09-11 mainnet sample. The other entries are exact public
    // source entry points scoped to this declared program ID.
    anchorActions: {
      swap: "SWAP",
      swap_v2: "SWAP",
      swap_router_base_in: "SWAP",
      create_pool: "CREATE_POOL",
      open_position: "OPEN_POSITION",
      open_position_v2: "OPEN_POSITION",
      open_position_with_token22_nft: "OPEN_POSITION",
      close_position: "CLOSE_POSITION",
      increase_liquidity: "ADD_LIQUIDITY",
      increase_liquidity_v2: "ADD_LIQUIDITY",
      decrease_liquidity: "REMOVE_LIQUIDITY",
      decrease_liquidity_v2: "REMOVE_LIQUIDITY",
      collect_protocol_fee: "COLLECT_FEES",
      collect_fund_fee: "COLLECT_FEES",
      collect_remaining_rewards: "COLLECT_REWARD"
    }
  },
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: {
    actions: SWAP_ACTIONS,
    // raydium-cp-swap commit 59fb845; `swap_base_input` matched the observed
    // 8fbe5ada… discriminator in a finalized mainnet transaction.
    anchorActions: {
      initialize: "CREATE_POOL",
      initialize_with_permission: "CREATE_POOL",
      deposit: "ADD_LIQUIDITY",
      withdraw: "REMOVE_LIQUIDITY",
      swap_base_input: "SWAP",
      swap_base_output: "SWAP"
    }
  },
  routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS: { actions: SWAP_ACTIONS },
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: {
    actions: { ...SWAP_ACTIONS, openPosition: "OPEN_POSITION", closePosition: "CLOSE_POSITION", increaseLiquidity: "ADD_LIQUIDITY", decreaseLiquidity: "REMOVE_LIQUIDITY" },
    anchorActions: {
      swap: "SWAP",
      swap_v2: "SWAP",
      two_hop_swap: "SWAP",
      two_hop_swap_v2: "SWAP",
      open_position: "OPEN_POSITION",
      open_position_with_metadata: "OPEN_POSITION",
      open_position_with_token_extensions: "OPEN_POSITION",
      close_position: "CLOSE_POSITION",
      close_position_with_token_extensions: "CLOSE_POSITION",
      increase_liquidity: "ADD_LIQUIDITY",
      increase_liquidity_v2: "ADD_LIQUIDITY",
      decrease_liquidity: "REMOVE_LIQUIDITY",
      decrease_liquidity_v2: "REMOVE_LIQUIDITY",
      collect_fees: "COLLECT_FEES",
      collect_fees_v2: "COLLECT_FEES",
      collect_reward: "COLLECT_REWARD",
      collect_reward_v2: "COLLECT_REWARD",
      initialize_pool: "INITIALIZE",
      initialize_pool_v2: "INITIALIZE"
    }
  },
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP": { actions: SWAP_ACTIONS },
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: { actions: SWAP_ACTIONS },
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: { actions: SWAP_ACTIONS },
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: { actions: SWAP_ACTIONS },
  srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX: { actions: SWAP_ACTIONS },
  opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb: { actions: SWAP_ACTIONS },
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin": { actions: SWAP_ACTIONS },
  EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S: { actions: SWAP_ACTIONS },
  SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ: { actions: SWAP_ACTIONS },

  // ---------------- Memecoin ----------------
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": {
    actions: { buy: "BUY", sell: "SELL", create: "CREATE_TOKEN", trade: "TRADE" },
    anchorActions: { buy: "BUY", sell: "SELL", create: "CREATE_TOKEN", withdraw: "WITHDRAW" }
  },
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: {
    actions: { buy: "BUY", sell: "SELL" },
    anchorActions: { buy: "BUY", sell: "SELL", create_pool: "CREATE_POOL", deposit: "DEPOSIT", withdraw: "WITHDRAW" }
  },
  pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ: { fallbackAction: "PROTOCOL_FEE" },

  // ---------------- Lending / perps ----------------
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: {
    actions: LENDING_ACTIONS,
    anchorActions: {
      deposit_reserve_liquidity: "DEPOSIT",
      deposit_reserve_liquidity_and_obligation_collateral: "DEPOSIT",
      deposit_obligation_collateral: "DEPOSIT",
      redeem_reserve_collateral: "WITHDRAW",
      withdraw_obligation_collateral: "WITHDRAW",
      withdraw_obligation_collateral_and_redeem_reserve_collateral: "WITHDRAW",
      borrow_obligation_liquidity: "BORROW",
      repay_obligation_liquidity: "REPAY",
      liquidate_obligation_and_redeem_reserve_collateral: "LIQUIDATE",
      flash_borrow_reserve_liquidity: "FLASH_BORROW",
      flash_repay_reserve_liquidity: "FLASH_REPAY",
      init_obligation: "INITIALIZE",
      refresh_reserve: "REFRESH_STATE",
      refresh_reserves_batch: "REFRESH_STATE",
      refresh_obligation: "REFRESH_STATE"
    }
  },
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH: {
    actions: LENDING_ACTIONS,
    anchorActions: {
      deposit: "DEPOSIT",
      withdraw: "WITHDRAW",
      transfer_deposit: "TRANSFER",
      place_orders: "PLACE_ORDER",
      place_perp_order: "PLACE_ORDER",
      place_spot_order: "PLACE_ORDER",
      place_and_take_perp_order: "PLACE_ORDER",
      place_and_take_spot_order: "PLACE_ORDER",
      cancel_order: "CANCEL_ORDER",
      cancel_orders: "CANCEL_ORDER",
      fill_perp_order: "FILL_ORDER",
      fill_spot_order: "FILL_ORDER",
      settle_pnl: "SETTLE_PNL",
      liquidate_perp: "LIQUIDATE",
      liquidate_spot: "LIQUIDATE",
      initialize_user: "INITIALIZE"
    }
  },
  MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA: { actions: LENDING_ACTIONS },
  So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo: { actions: LENDING_ACTIONS },
  "4MangoMjqJ2firMokCjjGgoK8d4MXcrgL7XJaL3w6fVg": { actions: LENDING_ACTIONS },
  ZETAxsqBRek56DhiGXrn75yj2NHU3aYUnxvHXpkf3aD: { actions: LENDING_ACTIONS },

  // ---------------- Metaplex ----------------
  // Shank u8 instruction indices, confirmed against mainnet by SPL
  // co-occurrence. Unmapped indices fall through to the fallback.
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: {
    actions: {
      createMetadataAccount: "CREATE_METADATA",
      createMetadataAccountV2: "CREATE_METADATA",
      createMetadataAccountV3: "CREATE_METADATA",
      updateMetadataAccount: "UPDATE_METADATA",
      updateMetadataAccountV2: "UPDATE_METADATA",
      mintNewEditionFromMasterEditionViaToken: "MINT_EDITION",
      transfer: "TRANSFER"
    },
    // Admission rule for u8 indices: an index is mapped only if it was
    // OBSERVED in mainnet instruction data with corroborating SPL token
    // behaviour, or if it is BRACKETED between two observed indices in the
    // same contiguous run (its position in the instruction enum is then
    // pinned by its neighbours). Indices recalled from documentation but
    // never observed are not mapped — recalled-but-unverified is precisely
    // the source that produced four dead program addresses.
    //
    // Evidence, from 590 sampled mainnet transactions:
    //   15 observed, nests initializeMint2 + mintTo + setAuthority
    //   33 observed, nests initializeMint2 + mintTo   (x22)
    //   41 observed, nests burn + closeAccount
    //   42 observed, nests initializeMint2 + mintTo
    //   43 observed, nests initializeMint2 + mintTo
    //   44 observed, nests approve + freezeAccount
    //   45 observed, nests revoke + thawAccount
    //   46 bracketed by observed 45 and 47
    //   47 observed, nests thawAccount
    //   49 observed, nests transferChecked in all 132 occurrences
    byteActions: {
      15: "UPDATE_METADATA",
      33: "CREATE_METADATA",
      41: "BURN_NFT",
      42: "CREATE_METADATA",
      43: "MINT_NFT",
      44: "DELEGATE",
      45: "REVOKE_DELEGATE",
      46: "LOCK_NFT",
      47: "UNLOCK_NFT",
      49: "TRANSFER"
    },
    fallbackAction: "METADATA_INTERACTION"
  },
  BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY: {
    anchorActions: {
      mint_v1: "MINT_COMPRESSED_NFT",
      mint_v2: "MINT_COMPRESSED_NFT",
      mint_to_collection_v1: "MINT_COMPRESSED_NFT",
      transfer: "TRANSFER",
      transfer_v2: "TRANSFER",
      burn: "BURN_NFT",
      burn_v2: "BURN_NFT",
      delegate: "DELEGATE",
      delegate_v2: "DELEGATE",
      redeem: "REDEEM",
      cancel_redeem: "CANCEL_REDEEM",
      decompress_v1: "DECOMPRESS_NFT",
      create_tree: "CREATE_TREE",
      create_tree_v2: "CREATE_TREE",
      set_tree_delegate: "SET_TREE_DELEGATE",
      verify_creator: "VERIFY_CREATOR",
      unverify_creator: "UNVERIFY_CREATOR",
      verify_collection: "VERIFY_COLLECTION",
      unverify_collection: "UNVERIFY_COLLECTION",
      set_and_verify_collection: "VERIFY_COLLECTION",
      update_metadata: "UPDATE_METADATA",
      update_metadata_v2: "UPDATE_METADATA"
    }
  },
  CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR: {
    anchorActions: {
      mint: "MINT_NFT",
      mint_v2: "MINT_NFT",
      initialize: "INITIALIZE",
      initialize_v2: "INITIALIZE",
      add_config_lines: "ADD_CONFIG_LINES",
      update: "UPDATE",
      withdraw: "WITHDRAW",
      set_authority: "SET_AUTHORITY",
      set_mint_authority: "SET_AUTHORITY",
      set_collection: "SET_COLLECTION",
      set_collection_v2: "SET_COLLECTION"
    }
  },
  Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g: {
    anchorActions: {
      mint: "MINT_NFT",
      mint_v2: "MINT_NFT",
      initialize: "INITIALIZE",
      update: "UPDATE",
      wrap: "WRAP",
      unwrap: "UNWRAP",
      withdraw: "WITHDRAW",
      route: "GUARD_ROUTE"
    }
  },
  cndy3Z4yapfJBmL3ShUp5exZKqR3z33thTzeNMm2gRZ: {
    anchorActions: { mint_nft: "MINT_NFT", initialize_candy_machine: "INITIALIZE", update_candy_machine: "UPDATE", withdraw_funds: "WITHDRAW", add_config_lines: "ADD_CONFIG_LINES" }
  },
  hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk: {
    anchorActions: {
      buy: "BID",
      public_buy: "BID",
      sell: "LIST",
      execute_sale: "EXECUTE_SALE",
      execute_partial_sale: "EXECUTE_SALE",
      cancel: "CANCEL",
      deposit: "DEPOSIT",
      withdraw: "WITHDRAW",
      withdraw_from_fee: "WITHDRAW",
      withdraw_from_treasury: "WITHDRAW",
      create_auction_house: "INITIALIZE",
      update_auction_house: "UPDATE",
      print_bid_receipt: "RECEIPT",
      print_listing_receipt: "RECEIPT",
      print_purchase_receipt: "RECEIPT",
      cancel_bid_receipt: "RECEIPT",
      cancel_listing_receipt: "RECEIPT"
    }
  },
  auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg: { fallbackAction: "AUTH_RULE_CHECK" },
  CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d: {
    // mpl-core IDL at commit e72d63e: TransferV1 is enum index 14. Index 14
    // was observed in all eight resolved transactions in the bounded sample.
    byteActions: { 14: "TRANSFER" }
  },

  // ---------------- Tensor ----------------
  TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN: {
    anchorActions: {
      // The reused TSWAP address is now Tensor Escrow. Exact entry points
      // from tensor-foundation/escrow commit ab2a30d.
      init_update_tswap: "INITIALIZE",
      init_margin_account: "INITIALIZE",
      close_margin_account: "CLOSE_ESCROW",
      deposit_margin_account: "DEPOSIT",
      withdraw_margin_account: "WITHDRAW",
      withdraw_margin_account_cpi_tamm: "WITHDRAW",
      withdraw_margin_account_cpi_tcomp: "WITHDRAW"
    }
  },
  TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp: {
    anchorActions: {
      buy: "BUY",
      buy_legacy: "BUY",
      buy_core: "BUY",
      list: "LIST",
      list_core: "LIST",
      delist: "DELIST",
      delist_core: "DELIST",
      edit: "EDIT_LISTING",
      bid: "BID",
      cancel_bid: "CANCEL_BID",
      take_bid_meta_hash: "TAKE_BID",
      take_bid_full_meta: "TAKE_BID",
      take_bid_legacy: "TAKE_BID",
      take_bid_core: "TAKE_BID",
      close_expired_bid: "EXPIRE_BID",
      close_expired_listing: "EXPIRE_LISTING",
      tcomp_noop: "MARKETPLACE_EVENT_LOG"
    }
  },
  TB1Dqt8JeKQh7RLDzfYDJsq8KS4fS2yt87avRjyRxMv: {
    anchorActions: { bid: "BID", cancel_bid: "CANCEL_BID", take_bid: "TAKE_BID", close_expired_bid: "EXPIRE_BID" }
  },
  TLoCKic2wGJm7VhZKumih4Lc35fUhYqVMgA4j389Buk: { fallbackAction: "NFT_LOCK_INTERACTION" },

  // ---------------- Magic Eden ----------------
  M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K: {
    actions: { buy: "BUY", sell: "SELL", list: "LIST", delist: "DELIST", executeSale: "SELL" },
    anchorActions: { buy: "BID", buy_v2: "BID", sell: "LIST", execute_sale: "EXECUTE_SALE", execute_sale_v2: "EXECUTE_SALE", cancel_buy: "CANCEL_BID", cancel_sell: "DELIST", deposit: "DEPOSIT", withdraw: "WITHDRAW" },
    fallbackAction: "MARKETPLACE_INTERACTION"
  },
  mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc: {
    anchorActions: {
      sol_fulfill_buy: "SELL",
      sol_fulfill_sell: "BUY",
      sol_mip1_fulfill_buy: "SELL",
      sol_mip1_fulfill_sell: "BUY",
      sol_ocp_fulfill_buy: "SELL",
      sol_ocp_fulfill_sell: "BUY",
      create_pool: "CREATE_POOL",
      update_pool: "UPDATE_POOL",
      sol_close_pool: "CLOSE_POOL",
      sol_deposit_buy: "DEPOSIT",
      sol_withdraw_buy: "WITHDRAW",
      deposit_sell: "DEPOSIT_NFT",
      withdraw_sell: "WITHDRAW_NFT",
      set_shared_escrow: "SET_SHARED_ESCROW"
    }
  },
  SHARKobtfF1bHhxD2eqftjHBdVSCbKo9JtgK71FhELP: {
    anchorActions: { offer_loan: "OFFER_LOAN", take_loan: "TAKE_LOAN", repay_loan: "REPAY", foreclose_loan: "LIQUIDATE", cancel_offer: "CANCEL" }
  },

  // ---------------- Staking / LST ----------------
  MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD: {
    actions: { deposit: "DEPOSIT", withdraw: "WITHDRAW", liquidUnstake: "UNSTAKE", delegateStake: "DELEGATE", orderUnstake: "UNSTAKE" },
    anchorActions: { deposit: "DEPOSIT", liquid_unstake: "UNSTAKE", order_unstake: "UNSTAKE", claim: "CLAIM", deposit_stake_account: "DEPOSIT" }
  },
  SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy: { fallbackAction: "STAKE_POOL_INTERACTION" },

  // ---------------- Bridge ----------------
  worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth: {
    actions: { postMessage: "BRIDGE_OUT", postVaa: "BRIDGE_IN", transfer: "TRANSFER", transferNative: "BRIDGE_OUT" }
  },
  wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb: {
    actions: { transferNative: "BRIDGE_OUT", transferWrapped: "BRIDGE_OUT", completeNative: "BRIDGE_IN", completeWrapped: "BRIDGE_IN" }
  },

  // ---------------- Multisig / infrastructure ----------------
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: {
    anchorActions: { multisig_create: "MULTISIG_CREATE", vault_transaction_create: "MULTISIG_PROPOSE", proposal_create: "MULTISIG_PROPOSE", proposal_approve: "MULTISIG_APPROVE", vault_transaction_execute: "MULTISIG_EXECUTE" }
  },
  T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt: { fallbackAction: "MEV_TIP" },
  ComputeBudget111111111111111111111111111111: { fallbackAction: "COMPUTE_BUDGET" },
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: { fallbackAction: "ASSOCIATED_TOKEN_ACCOUNT" },
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: { fallbackAction: "MEMO" },
  cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK: { fallbackAction: "STATE_COMPRESSION" },
  noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV: { fallbackAction: "STATE_COMPRESSION_LOG" },
  namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX: { fallbackAction: "NAME_SERVICE_INTERACTION" },
  FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH: { fallbackAction: "ORACLE_UPDATE" },
  SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f: { fallbackAction: "ORACLE_UPDATE" }
};

/**
 * Program IDs that carry instruction semantics.
 *
 * `SEMANTICS` is keyed by program ID, but it is NOT a second source of truth:
 * a key the catalog does not contain is never consulted, so a stale key would
 * silently strip a protocol of every action mapping — the same class of
 * failure as a dead address. `registry.test.ts` asserts every key resolves.
 */
export const SEMANTICS_PROGRAM_IDS: string[] = Object.keys(SEMANTICS);

/** Programs the catalog knows, joined with their instruction semantics. */
export const PROTOCOL_PARSERS: ProtocolParserDefinition[] = CANONICAL_PROGRAMS.map((program) => {
  const semantics = SEMANTICS[program.programId] ?? {};
  return {
    programId: program.programId,
    label: program.label,
    category: program.category,
    actions: semantics.actions ?? {},
    anchorActions: semantics.anchorActions,
    byteActions: semantics.byteActions,
    fallbackAction: semantics.fallbackAction
  };
});

const byId = new Map(PROTOCOL_PARSERS.map((p) => [p.programId, p]));

/** Anchor discriminator lookups, computed once at module load. */
const anchorLookups = new Map<string, Map<string, string>>();
for (const definition of PROTOCOL_PARSERS) {
  if (definition.anchorActions) {
    anchorLookups.set(definition.programId, buildAnchorLookup(definition.anchorActions));
  }
}

export function parserFor(programId: string): ProgramParser | null {
  const def = byId.get(programId);
  if (!def) return null;
  return {
    programId: def.programId,
    label: def.label,
    category: def.category,
    parse(ix: ParsedInstruction) {
      // 1. Natively parsed instruction type.
      const type = ix.parsed?.type;
      const parsedAction = type ? def.actions[type] : undefined;
      if (parsedAction) return { actionType: parsedAction };

      // 2. Anchor 8-byte discriminator over raw instruction data.
      const anchorLookup = anchorLookups.get(def.programId);
      if (anchorLookup) {
        const anchorAction = matchAnchorAction(ix.data, anchorLookup);
        if (anchorAction) return { actionType: anchorAction };
      }

      // 3. Shank single-byte instruction index.
      if (def.byteActions) {
        const byteAction = matchByteAction(ix.data, def.byteActions);
        if (byteAction) return { actionType: byteAction };
      }

      // Recognized program, unknown instruction: fall back to a generic
      // protocol action so the interaction is still semantically classified
      // (D3-B §18-21). Programs without an explicit fallback return null so
      // unrecognized instructions are honestly counted as PARTIALLY_PARSED.
      if (def.fallbackAction) return { actionType: def.fallbackAction };
      return null;
    }
  };
}

export function protocolCategoryFor(programId: string): ProtocolCategory {
  return byId.get(programId)?.category ?? "UNKNOWN";
}

export function programLabelFor(programId: string): string | null {
  return byId.get(programId)?.label ?? null;
}
