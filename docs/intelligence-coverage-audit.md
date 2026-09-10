# Intelligence Coverage Audit — Pre-Production Freeze

Evidence date: 2026-09-11 (Asia/Jakarta). This is a bounded coverage audit,
not a claim about lifetime Solana activity or every instruction a program has
ever exposed.

## Sampling method and limits

The audit requested the eight most recent finalized signatures for each of 23
registered Raydium, Pump.fun, Kamino, Drift, Metaplex, Tensor, and Magic Eden
program variants. A transaction was counted only when RPC returned the full
transaction and the target program was actually invoked. Address-only
mentions were excluded. Top-level and inner instructions were both inspected.

The sample resolved 170+ target-program instructions. Public RPC throttling
was handled with fixed retries and pacing; no unresolved RPC request was
counted in a denominator. Coverage below is therefore transaction-weighted
within this sample, not method-count coverage and not an ecosystem estimate.

`fully mapped transaction` means every observed instruction for that target
program had semantics. This conservative measure is intentionally lower than
"at least one instruction was mapped".

## Before/after observed coverage

| Protocol family | Resolved target transactions | Fully mapped before | Fully mapped after | After coverage | Remaining reason |
|---|---:|---:|---:|---:|---|
| Raydium | 21 | 1 | 13 | 61.9% | Router implementation/source unavailable |
| Kamino | 8 | 8 | 8 | 100% | No unknown in this bounded sample |
| Drift | 8 | 0 | 0 | 0% fully mapped; 50% instruction share | Rejected `cancel_orders_by_ids` calls remain unmapped |
| Tensor | 24 | 16 | 16 | 66.7% | Current Tensor Bid selectors lack authoritative source |
| Metaplex | 52 | 44 | 52 | 100% | Core `TransferV1` attributed |
| Pump.fun / PumpSwap | 16 | 6 | 6 | 37.5% | Event-style and unattributed selectors remain unknown |
| Magic Eden / MMM | 16 | 16 | 16 | 100% | No unknown in this bounded sample |

Zero resolved transactions for Tensor Escrow and Metaplex Token Auth Rules are
not reported as 100%; they are **not measured** in this sample.

## Unknown selector inventory before coding

Program IDs:

- Raydium AMM v4: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
- Raydium CLMM: `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`
- Raydium CPMM: `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`
- Raydium Router: `routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS`
- Pump.fun: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- PumpSwap: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
- Drift v2: `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`
- Metaplex Core: `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`

The inventory contained 18 distinct selectors when u8 programs are grouped by
their actual leading index (rather than incorrectly grouping on the first
eight payload bytes). `data` is the exact base58 instruction data from the
sample. Co-occurrence is bounded to relevant known programs.

| Program | Encoding / raw selector | Sample signature / slot | data | Accounts | Known co-occurrence | Frequency | Before coverage |
|---|---|---|---|---:|---|---:|---|
| Raydium AMM v4 | u8 `16` | `4WaQZGcF93oxek4zG8YSQZn62BQEBYh3kHnA5V3ZSoxbBdwUFJeyQNAiWgwKxgiSejDj4HYAMkfKvpqzsrmpJ8th` / 445936991 | `A7NFwYtM45HeNa5XdtQa9VH` | 8 | Raydium CLMM, SPL Token | 5 | unknown |
| Raydium CLMM | Anchor8 `2b04ed0b1ac91e62` | `4qy2dvujttCygP7GQR2ggAxzyoxL8Ge7H1QFDU3XY9Z3NVm7J4Rs1Qx8QTidjrdhrKwUJoeYHBw5SBm4keLUBCMG` / 445937011 | `ASCsAbe1UnDuHhuyQqHuicoMzCUKuHCp9nTw36u7Y5HWqmj3pevmWuoW` | 15 | Jupiter, PumpSwap, SPL Token | 6 | unknown |
| Raydium CPMM | Anchor8 `8fbe5adac41e33de` | `5P4ThfQV3NB2g7bpfpC3Ln4YGsFfy8cXDVCx6Zea7TLEcmVBcqbRgCxYrv9zJWUV84tPgVcxkYHu9B8tavdEBu1P` / 445937051 | `E73fXHPWvSRUqbcrS5a8yeVZqeK6yMKHR` | 13 | Pump.fun, SPL Token | 1 | unknown |
| Raydium Router | raw prefix `01b7467305000000` | `24RdUjjgSmu6cfg4wf7Z8TmTeE2HDNqpeQsaHRKGDDWtgqyoVmbKXzk7J1rSU2cEZNzB1ZukSRfQUxxxe9LVwVa8` / 445937060 | `wF8P7dNM64hJpP8ZPk3ar3` | 33 | Compute Budget | 4 | unknown |
| Raydium Router | raw prefix `00c5bebf55050000` | `r2nKatTAF72AtE2zwjHBPdBo2oZKtB3wZPgGEmmJzm2EcRiCP6F7KGiU6pwPQPfgVAxrp3Zhzs3SHcf9wEAuRQf` / 445937060 | `1RRGXb1uc5ZPkCj39ANFcTH` | 31 | Raydium CLMM, SPL Token | 1 | unknown |
| Raydium Router | raw prefix `014701b678705700` | `5aEyHDbmTdnJX2s4xJ9HjSeqrexETw4nQcRJABkoRSp26pNYH4SaQxeDgxZNdpuCTJ8KiEEmwQhTSGj5avPnmeMa` / 445937045 | `hP3vjHfiSVUQrRMmVaSAKq` | 19 | Raydium CLMM, SPL Token | 1 | unknown |
| Raydium Router | raw prefix `00768c6bc7020000` | `38XrmKAg4M4JErBYdt68czsYrcDWfwBmCWuAEUs1Wt2cXfLePEVZwpFkMBredvR5yRvxGDvTuTchCs1U357oNqds` / 445937040 | `1Fe4BVRF1uRYqZQNU1oPhSf` | 29 | Raydium CLMM/CPMM, SPL Token | 1 | unknown |
| Raydium Router | short raw `06` | `38XrmKAg4M4JErBYdt68czsYrcDWfwBmCWuAEUs1Wt2cXfLePEVZwpFkMBredvR5yRvxGDvTuTchCs1U357oNqds` / 445937040 | `7` | 6 | Raydium CLMM/CPMM, SPL Token | 2 | unknown |
| Raydium Router | raw prefix `058074d21a000000` | `3Bsctbm4ea7eZWnahtxueqwNncb21USAYT5sup5Sm2AduNXXKv3XzFRWp2nZBShPDNdrNexu1Xe8M23SCyXtXB3K` / 445937035 | `54anrxkDQL4o` | 6 | Raydium CLMM, SPL Token | 1 | unknown |
| Raydium Router | raw prefix `008074d21a000000` | same / 445937035 | `1Gs1tyrSYpzJ8JysU1ZqVpj` | 31 | Raydium CLMM, SPL Token | 1 | unknown |
| Pump.fun | Anchor8 `38fc74089edfcd5f` | `4aHCHJ4RSQPKSc1kp7jo3cEBpG8meoCC1fTFnB9vnzspD7HJy3fD7g9HjXHbrjHAVyP4uKyvDbGzQPTB2gtxi6Fo` / 445937115 | `PvwdRapqdNv7KFUmC8CpgT2Y9GH6qM4XkL` | 18 | System | 3 | unknown |
| Pump.fun | Anchor8 `c2ab1c46684d5b2f` | `5yiK8mYfaXT2nnKPfTY4MJdbpcX2xJERx8WgcN9To7F48pN6nw9J8J4ELntjehgG35Un5izxBs45DNvdzwKjUH3x` / 445937115 | `JkK5BJGr6ZHEm3ALLBKsRUHTaj3A1hdt3` | 27 | Pump fee, SPL Token | 1 | unknown |
| Pump.fun | Anchor8 `e445a52e51cb9a1d` | same / 445937115 | `4DRpSvv25WyUKMa1NGJtcNkoFwgmr1Doc2Sj9ok27dUfAHcnorC1BvL21AvieC4J1dQcQBfvF2cNWQPNdnnrW1ZrJZH2LeT3o4ZehxaeSiTt3Dh3u8EPpnZaLhm6EwTZ5vwsJCVC3bu8UYX6dnqzHT7F8dKCRu4Fb7WjAPU9jVroiNw6gPqLWAe1K1DkaLGd7s1Pzht5txzmGtTHHi9qf33w89ZBtL2JLgcCtHJfhyUq74mHuFy6eXqXxjfFkR8L91hCnnAmdXGF8nqJDSXZgJSzQGbMuJ3UTVaz59rT3QQjsiXJEtSF3AVRGCwQgN9KsimwnYuRH87dXMDRcv7syzuNaknyaYWXwX2yXsPs6wAdZvPyfg5fH9owU9DXHfQ5s8hG8JUL6aayVjKDSWnekXKuWhpXJtdgD99mvUKDGqhrSFjHedGR8NtDJmXikwxwGXX55CpQgnqJwDgiMabRksgff4KsSgqior9CswSQwGEdasTgKmQbwcxyrJ2dTZznLdqEVc5AF` | 1 | Pump fee, SPL Token | 2 | event-style; unknown action |
| Pump.fun | Anchor8 `5df6823ce7e940b2` | `4nNLqmCKKESBzN1WKtWXpKTZTjRiBeqF19yRRfTiiAEvT1DDGJFR64WisVRnSMrEfaS5aKvbrZCYLHPBKmyrsFvk` / 445937115 | `9Zq9ZwMbe2cBG6qB3TxJ3LJbq5TGVAxFH` | 26 | Pump fee, Token-2022 | 1 | unknown |
| PumpSwap | Anchor8 `e445a52e51cb9a1d` | `2ZXxr7v5dg1ceY92e5GnSiyH1G4S2QvqnF5j7fabYiAi5PJD5ytuHTbZ5XWerSuAYGnhygGvLKAyD9Ne2WSTzhxA` / 445937151 | event payload retained by signature | 1 | Pump fee, SPL Token | 5 | event-style; unknown action |
| PumpSwap | Anchor8 `c62e1552b4d9e870` | `2aMrDxBLMxjNvsmX8QJCzrBfNV8rxvGWFnN3w393uPHvMYnnCPTF2PHPhz5PaG1pfautihW36gVDMKtrHPKe1j1B` / 445937151 | `2Nk86asu1ki8ge8ZhhF6rrffXvoRvaRKmMS` | 25 | Pump fee, SPL Token | 2 | unknown |
| Drift v2 | Anchor8 `861390a55ef0d25e` | `4kf1HWvkbqYbeMdas7o66UJrnrzPUcExNUrRzdYMCRyxqneAqAmEVKtWdisBY8tZz8pnNYDaXKWFe65MMmwas82u` / 445923509 | `Dx6UJUk5WFaxmanzmeRyk8H1u233bSC4YRygZsdiE3ReufGKytCPNx5gCSDpcNmAsrbogryL268HGv7qc3wPg3mjVRAXQLbZhwqsmHUb` | 22 | Compute Budget | 8 | rejected on chain; unknown deployed semantic |
| Metaplex Core | Shank u8 `14` | `3nuv1T63MFksBhDsn2VBX5QAQgNEgTfMJ8xbx3Ws2u9NF3CEKoUCgWtQyXYHhT7WfRetz5wuBTu8tmMRp7ksupE` / 445937513 | `24o` | 7 | ATA, SPL Token | 8 | unknown |

One PumpSwap event payload is intentionally referenced by signature rather
than duplicated in this document because it is a large emitted event blob,
not an instruction selector requiring attribution. The bounded runtime metric
stores signatures, counts, and slots, not unbounded payloads.

## Attributions admitted

| Program/version | Mapping | Evidence |
|---|---|---|
| Raydium AMM v4 | u8 `16` → `SWAP` | `raydium-io/raydium-amm` commit `d26944b`, enum `SwapBaseInV2`; five finalized samples |
| Raydium CLMM | `2b04ed0b1ac91e62` → `SWAP` | `sha256("global:swap_v2")[0..8]`; `raydium-io/raydium-clmm` commit `ed7c84a`; six finalized samples |
| Raydium CPMM | `8fbe5adac41e33de` → `SWAP` | `sha256("global:swap_base_input")[0..8]`; `raydium-io/raydium-cp-swap` commit `59fb845`; finalized sample |
| Metaplex Core | u8 `14` → `TRANSFER` | `mpl-core` IDL order at commit `e72d63e`; eight finalized samples |
| Tensor Escrow | current method set and label | `tensor-foundation/escrow` commit `ab2a30d` and current Tensor protocol documentation; obsolete marketplace methods removed from this ID |

The Raydium CLMM and CPMM maps also include exact high-value entry points from
the same official source/program version. Anchor hashes cannot alias an
unrelated instruction in practical terms, and matching remains scoped to the
exact program ID.

## Attributions refused

- Raydium Router: deployed program is verified, but the router instruction
  implementation is not among Raydium's published open-source programs.
- Tensor Bid: observed and address-attributed, but no current authoritative
  source/IDL for `TB1D…` was located.
- Drift `861390…`: reconstructs to `cancel_orders_by_ids` in Drift commit
  `13e8e9b`, but sampled transactions fail with instruction fallback errors.
  This does not establish semantics for the deployed version.
- Pump/PumpSwap event-style invocations: a one-account emitted payload is not
  promoted into a user action.

These remain `UNKNOWN` / `PARTIALLY_PARSED`.

## Unknown-program observability

Each analysis now records a bounded top-20 list under data quality. Per
program it contains instruction count, transaction count, up to three sample
signatures, and first/last observed slots. Collection is capped at 50 program
IDs before ranking. Raw transactions and unbounded instruction payloads are
not retained. Runtime-native Compute Budget and SPL Associated Token Account
programs are recognized as common infrastructure and no longer inflate the
unknown-program confidence penalty.

Population-wide ranking requires legitimate analyzed-wallet data. The
operator repository now exposes `topUnknownPrograms(knownProgramIds, limit)`:
it excludes canonical programs, caps output at 100 rows, ranks interaction
frequency then distinct-wallet prevalence, and retains three signatures per
program. `potentialIntelligenceImpact` remains `UNASSESSED`; it is not derived
from frequency. No global rank is fabricated from this protocol-address
sample, so the report will populate only after real analysis ingestion.

## Entity and provenance audit

The existing model already carries entity class, source type, address role,
confidence, status, evidence source, verification timestamps, and notes.
Protocol programs, infrastructure, bridges, staking, marketplaces,
custodians, services, and other known wallets remain distinguishable through
the current `EntityType` plus `EntityAddressRole`; no schema churn is needed.

No exchange or custodial address was added. Protocol interaction remains
separate from public attribution. Tensor's reused `TSWAP…` address is now
labelled `Tensor Escrow` with role `ESCROW`, matching current authoritative
documentation.

## Commonality readiness

Population prevalence is based on distinct contributing wallets. Repeated
transactions affect the diagnostic observation count but cannot increment
`distinct_wallets`. Re-analysis replaces the prior wallet snapshot.

The replacement path now stores each prior per-wallet count and subtracts the
actual count; previously it subtracted one, allowing diagnostic transaction
counts to accumulate across re-analysis. The shared per-wallet scan is capped
at 5,000 observations by default. Operator state is explicit:
`DISABLED`, `INSUFFICIENT_POPULATION`, `STALE`, or `ACTIVE`.

Synthetic tests cover disabled, missing, below-threshold, stale, fresh-active,
and exact-threshold transitions. Synthetic observations are not loaded into
production. Current production data sufficiency is **NO / not measured**.

## Bounded history and disclosure

History fetching remains RPC-based and paginated. It now enforces the existing
maximum history days, uses Solana's bounded 1,000-signature page size up to the
configured transaction limit, deduplicates signatures, caps transaction RPCs
against `ANALYSIS_MAX_RPC_CALLS`, and stops scheduling new transaction calls
when `ANALYSIS_TIMEOUT_MS` is exhausted. Existing whole-analysis caching is
reused; no archival indexer or chain backfill was introduced.

Responses retain analyzed transaction count, history start/end, parser and
semantic coverage, and now include explicit `MOST_RECENT_BOUNDED` scope,
limits, budget-exhaustion flags, and whether interactions remained
unclassified. They do not imply lifetime coverage.

The normalizer test workload completed in 1.29 seconds wall time with 109 MiB
peak resident memory on the audit host. Selector additions are constant-time
map lookups and make no RPC calls; RPC count remains controlled by the existing
analysis limits. This is a current-state smoke measurement, not a production
latency benchmark or a claim about relative improvement from an unavailable
clean performance baseline.

## Roadmap feasibility (P6 only)

- **Wallet Context Profile:** bounded age/history depth, activity continuity,
  protocol diversity, counterparty concentration/diversity, public
  attribution exposure, and known-risk interactions are observable. A true
  lifetime wallet age and validated fraud/trust model are not. No reputation
  score or safety label is exposed.
- **AEGIX AI:** deterministic explanations already accept scores, signals,
  paths, confidence, and evidence. No `ExplanationProvider` or paid provider
  is integrated. Any future provider must be optional, fail-open, and
  non-authoritative; scores cannot depend on it.
- **Markets:** no licensed provider exists. Provider/event/correlation shapes
  remain architecture-only; no market data is fabricated or scraped.
- **Billing:** current beta quotas remain functional without payments. No
  payment processor is integrated.
- **Multi-chain:** Solana remains the only chain. No speculative second-chain
  implementation was added.
- **Webhook SDK:** current signed webhook contract is testable, but no package
  is published and it is not a freeze blocker.
- **$AEX:** planned only and not required by any live product.
