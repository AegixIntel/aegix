# Program Catalog — Identity, Verification, and Parser Coverage

Evidence date: 2026-09-10. This document covers how AEGIX decides which
on-chain program is which, why that decision used to be wrong, and what now
prevents it from going wrong silently.

Correctness fixes and coverage expansion are recorded separately, because they
carry different risk and different evidence requirements.

---

## 1. Correctness fixes

### 1.1 Program IDs that matched nothing

Program identities were maintained by hand in four independent places: the
entity seed, the normalizer parser registry, the account classifier, and a
hard-coded list inside `detectTransactionClass`. They drifted. Five entries
were unusable:

| Protocol | Address as shipped | Defect |
|---|---|---|
| Raydium AMM | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wF2tcy6u6` | Valid 32-byte key, **no account on mainnet** |
| Orca Whirlpools | `whirLbMiicVdio4qvUfM5KAg6Ct8VdjYdZyBf5byvVM` | Valid 32-byte key, **no account on mainnet** |
| Kamino Lending | `KLend2g3cP87fffH8vSekita2WqbcjYb75QHoWJvEPw` | Valid 32-byte key, **no account on mainnet** |
| Drift | `dRiftyHA39MWEi3m9aunc5tRFoFjCjFQ5uMYFnMqdfF` | Valid 32-byte key, **no account on mainnet** |
| Tensor (classifier only) | `TSWAPaqyCsxBPKKhB9A9d3SxJS1QyJzUHVN5VKHTWA` | Decodes to **31 bytes** — not a public key at all |

The failure was silent by construction:

```text
wrong program ID → matches nothing → counted as an unknown program
                 → semantic evidence lost
                 → entity evidence lost
                 → coverage and confidence affected
```

Corrected addresses were recovered by tallying program IDs from finalized
mainnet blocks and matching on the surviving vanity prefix, except Drift,
which came from the `drift-labs/protocol-v2` SDK config. All four were then
confirmed executable and loader-owned by RPC.

### 1.2 PumpSwap attributed to Raydium

`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` shipped labelled
"Raydium AMM v4". It is PumpSwap, Pump.fun's AMM: it carries the `pAMM`
vanity prefix and co-occurs with the Pump.fun fee program in mainnet blocks.
Every PumpSwap trade was attributed to the wrong protocol, the wrong entity
and the wrong protocol category. Guarded by a regression test in
`packages/blockchain/src/classifier.test.ts`.

### 1.3 Fixtures carrying their own copies

Golden and load fixtures held their own address literals and had rotted the
same way — a fixture named "Raydium AMM program" pointed at an address that
is not Raydium, and still passed. Those fixtures now resolve addresses from
the catalog by label, and an unknown label throws.

### 1.4 Commonality penalties keyed by entity

`COMMON_PROTOCOLS` and `COMMON_ENTITIES` hold canonical **entity** names, not
free-text program labels. As labels they were fragile: `"Raydium AMM"` never
matched a set entry of `"Raydium"`, and Jupiter owns five programs whose
labels would each have needed listing. When the penalty stops applying,
shared use of a popular protocol starts looking like correlation evidence —
measured at score 40 / MODERATE_CORRELATION for two wallets whose only
overlap was Jupiter and Raydium. `config.test.ts` asserts every name in both
sets still resolves to a catalog entity.

### 1.5 Same-signature temporal evidence

See `docs/` correlation notes and `packages/correlation/src/dimensions/temporal.ts`.
A transaction directly between two wallets appears in **both** wallets'
activity with one shared signature and one shared block time. Temporal
analysis paired it with itself, producing a guaranteed zero-second match and
a `TEMPORAL_CORRELATION` family built entirely from evidence the `FUNDING` and
`TRANSFER_RELATIONSHIP` families had already counted. `excludedSignatures`
existed in the input type but was never read.

Transactions shared by both wallets are now excluded before every temporal
signal — window matching *and* the hour/day distributions, since identical
activity also produces a perfect distribution match. The exclusion is
targeted: wallets that transact directly **and** act coincidentally through
third parties still produce temporal evidence from the third-party activity.

### 1.6 Test discovery

Package test scripts used an unquoted `src/**/*.test.ts`. Bash without
`globstar` expands `**` as a single `*`, so once any package gained a test
file in a subdirectory, the shell resolved the pattern itself and node never
saw the root-level files. `packages/normalizer/src/normalizer.test.ts` stopped
executing. Patterns are now quoted so node performs the expansion, in every
package and at the repository root.

---

## 2. Coverage expansion

Registry: **17 → 59 programs**, adding Metaplex, Tensor, further DeFi,
staking, bridge and infrastructure coverage, plus real instruction-level
semantics for programs the RPC does not parse.

### 2.1 Single source of truth

`packages/types/src/programs.ts` is the only place a program address is
written down. The entity seed, normalizer registry, account classifier and
transaction-class detection all derive from it. `SEMANTICS` in the parser
registry is keyed by program ID but is not a second source of truth: a stale
key is never consulted, so `registry.test.ts` asserts every key resolves to a
catalog program.

Infrastructure programs (memo, state compression, oracles, name service)
carry `seedAsEntity: false`. They are parsed for semantic coverage but never
seeded as attributable entities: nearly every wallet touches them, so shared
use is not attribution evidence.

### 2.2 Parser strategies

`getParsedTransaction` only fills `instruction.parsed.type` for programs the
validator knows natively. Every Metaplex, Tensor and Magic Eden program
returns raw base58 data, so an action map keyed on `parsed.type` could never
match them — which is why NFT activity landed as `PARTIALLY_PARSED`.

Three strategies run in order, all scoped to the owning program ID:

1. `actions` — RPC-parsed instruction type.
2. `anchorActions` — Anchor's 8-byte `sha256("global:<method>")` prefix.
3. `byteActions` — Shank's single u8 instruction index.

The two carry opposite risk, and are held to different standards:

- An Anchor **method name** is hashed into a discriminator, so a wrong name
  produces bytes that match nothing. It can fail to add coverage; it cannot
  invent an action. Many names in the registry were confirmed by observing
  their computed discriminator in real mainnet instruction data; the rest are
  plausible names that have not been observed. **This list is not a verified
  instruction inventory for any protocol.**
- A **u8 index** means something for every program, so a wrong index invents
  an action. These maps are restricted to indices observed on mainnet, or
  bracketed between two observed indices in the same contiguous enum run.

Token Metadata evidence, from 590 sampled mainnet transactions: index 49
nested `transferChecked` in all 132 occurrences; 33 nested
`initializeMint2`+`mintTo`; 41 nested `burn`+`closeAccount`; 44 nested
`approve`; 45 nested `revoke`; 47 nested `thawAccount`; 46 is bracketed by
observed 45 and 47. Indices recalled from documentation but never observed
(0, 1, 10, 11, 16, 18, 22, 29, 50, 52, 53) are **not** mapped — recalled but
unverified is precisely the source that produced the four dead addresses.
Raydium AMM v4 indices 9 and 11 each nested exactly two SPL transfers under a
17-byte instruction, which is the swap layout.

### 2.3 Measured effect on real mainnet transactions

| Protocol | Recognized before | Actions parsed now |
|---|---|---|
| Metaplex Bubblegum | no — unknown program | `TRANSFER`, `MINT_COMPRESSED_NFT`, `UPDATE_METADATA`, `BURN_NFT` |
| Metaplex Token Metadata | yes, but no action ever matched | `TRANSFER`, `CREATE_METADATA`, `DELEGATE` |
| Tensor Compressed | no — unknown program | `BID`, `EDIT_LISTING`, `LIST`, `DELIST` |
| TensorSwap | no — unknown program | `DEPOSIT`, `WITHDRAW` |
| Raydium AMM v4 | no — dead address | `SWAP` |
| Orca Whirlpools | no — dead address | `SWAP` |
| Kamino Lending | no — dead address | `FLASH_BORROW`, `FLASH_REPAY`, `REFRESH_STATE` |
| Drift v2 | no — dead address | `PLACE_ORDER` |

### 2.4 Why fallback actions stay rare

`semanticCoverage` is the share of instructions whose semantics were actually
understood, and it caps the confidence AEGIX reports. Giving every program a
generic fallback would push coverage toward 1.0 and make the engine *more*
confident about data it understands *less*. A fallback is allowed only where
the program does exactly one thing (memo, fee, tip, oracle update, auth-rule
check) or where it is long-established behaviour (Token Metadata, Magic Eden
v2). Everywhere else an unmatched instruction returns null and the
transaction is honestly counted as `PARTIALLY_PARSED`.

Protocol attribution never depends on the fallback: the interaction row is
written either way, carrying the program label and protocol category.

---

## 3. What verification proves, and what it does not

These are five different claims and must not be collapsed:

| Claim | Meaning | Enforced by |
|---|---|---|
| `STRUCTURALLY_VALID` | base58 decoding to exactly 32 bytes | `packages/types/src/programs.test.ts`, in `pnpm test` |
| `MAINNET_PRESENT` | an account exists at that address | `pnpm verify:programs` |
| `EXECUTABLE_PROGRAM` | `account.executable === true` | `pnpm verify:programs` |
| `LOADER_VALID` | owned by a Solana program loader | `pnpm verify:programs` |
| `PROTOCOL_ATTRIBUTION` | evidence that this program belongs to the protocol AEGIX names | per-entry `evidenceSource`; **not machine-checked** |

`pnpm verify:programs` proves the first four. It cannot prove the fifth: an
executable, loader-owned account is a deployed program, not proof of *whose*
program it is. **A green verification run must never be read as "protocol
identity confirmed."**

Catalog status follows architecture.md §37. `VERIFIED` means identity is
confirmed by protocol-owned documentation or by a vanity prefix spelling the
protocol name plus an observed executable account. `PROBABLE` means the
program is real but the name rests on community documentation.

Failure semantics are separated so an outage is never misread as a defect: an
unreachable or malformed RPC exits **2** and reports nothing about the
catalog, while a genuine account-level defect exits **1**. Both are non-zero,
so `scripts/release-gate.sh` blocks either way. Requests are batched (50 per
call), bounded by a 15s per-request timeout and 4 attempts, and are read-only
public chain queries.

---

## 4. Known remaining gaps

- **Unattributed discriminators.** Sampling 20 recent mainnet transactions for
  each of the 21 programs that carry instruction-data semantics found **26
  distinct discriminators the parser does not map**, across 13 programs — the
  largest groups being Kamino (5), Pump.fun bonding curve (3), PumpSwap (3),
  and 2 each for Jupiter v6, Tensor Bid, Magic Eden v2, Sharky and Squads v4.
  This is a floor, not a total: a wider sample will surface more. Their method
  names are not guessed; those instructions report as `PARTIALLY_PARSED`.
- **Partial instruction coverage** for Drift, Kamino and Raydium AMM v4: the
  high-volume instructions are mapped, the long tail is not.
- **Metaplex Token Metadata legacy indices** are deliberately unmapped until
  observed, so historical pre-unified-instruction NFT activity parses less
  than it could.
- The catalog covers **protocol programs only**. Exchange deposit and hot
  wallets remain deliberately absent: program identity and custodial address
  attribution have different epistemic standards, and weak attribution must
  not become fact.
