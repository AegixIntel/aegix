# AEGIX Signal Taxonomy

This document is the single reconciliation point between three vocabularies
that describe the same thing:

- the exposure categories named in the AEGIX whitepaper,
- the `SignalCategory` union in `packages/types/src/signal.ts`,
- the seven dimensions of the Privacy Exposure Score in `packages/scoring`.

They were allowed to drift. Anything user-facing — docs, API reference,
marketing copy — must use the mapping below rather than inventing a third
name for an existing concept.

## Whitepaper category → signal category → score dimension

| Whitepaper exposure category | `SignalCategory` | Score dimension |
|---|---|---|
| Identity Linkability | `IDENTITY_LINKABILITY` | `identityLinkability` |
| Exchange Exposure | `ENTITY` | `entityExposure` |
| Wallet Cluster Exposure | `CLUSTER` | `walletClusterExposure` |
| Behavioral Fingerprint | `BEHAVIORAL` | `behavioralFingerprint` |
| Counterparty Exposure | `COUNTERPARTY` | `counterpartyExposure` |
| Transaction Pattern Exposure | `TRANSACTION_PATTERN` | `transactionPatternExposure` |
| Public Attribution Signals | `PUBLIC_ATTRIBUTION` | component of `identityLinkability` |
| *(not named separately in the whitepaper)* | `FUNDING` | `fundingExposure` |

Two deliberate asymmetries:

1. **`FUNDING` has no whitepaper category of its own.** Funding provenance is
   the single strongest observable relationship on Solana, so the engine and
   the score keep it separate instead of folding it into counterparty
   exposure. User-facing copy may present it under Identity Linkability,
   which is where it carries most of its weight.
2. **`PUBLIC_ATTRIBUTION` is not its own score dimension.** It enters the
   score as the `public_attribution` component of `identityLinkability`
   (weight 0.2 in `DEFAULT_SCORING_CONFIG`). Adding an eighth dimension
   would be a breaking change to the API response, the database and the web
   client, and would say nothing the linkability dimension does not already
   carry.

## Category lifecycle audit

| `SignalCategory` | Declared | Emitted | Unit tested | Scoring use | Explained | Persisted | Visible |
|---|---|---|---|---|---|---|---|
| `IDENTITY_LINKABILITY` | yes | `analyzeLinkability` | yes | underlying evidence feeds `identityLinkability`; aggregate is not double-counted | yes | yes | top signals/API |
| `FUNDING` | yes | `analyzeFunding` | yes | `fundingExposure`, `identityLinkability` | yes | yes | top signals/API |
| `COUNTERPARTY` | yes | `analyzeCounterparties` | yes | `counterpartyExposure`, `identityLinkability` | yes | yes | top signals/API |
| `ENTITY` | yes | `analyzeEntities` | yes | `entityExposure`, `fundingExposure` | yes | yes | top signals/API |
| `BEHAVIORAL` | yes | `analyzeBehavior` | yes | `behavioralFingerprint` and bounded supporting components | yes | yes | top signals/API |
| `CLUSTER` | yes | `analyzeClusters` | yes | `walletClusterExposure`, `identityLinkability` | yes | yes | top signals/API |
| `TRANSACTION_PATTERN` | yes | `analyzeTransactionPatterns` | yes | measured pattern components only | yes | yes | top signals/API |
| `PUBLIC_ATTRIBUTION` | yes | `analyzePublicAttribution` | yes | `identityLinkability.public_attribution` | yes | yes | top signals/API |

There are no declared-only categories. All signals pass through the shared
intelligence repository and deterministic explanation layer. Visibility is
rank-dependent: persistence does not guarantee a signal appears in the
top-five summary, but it remains available to internal analysis/diff paths.

## Signals by category

Every signal type AEGIX can emit, the engine that owns it, and what it
measures. An engine never emits a category it does not own.

| Category | Signal type | Engine | Measures |
|---|---|---|---|
| `FUNDING` | `REPEATED_FUNDING` | `engines/funding.ts` | The same address funded this wallet more than once |
| `FUNDING` | `FUNDING_CONCENTRATION` | `engines/funding.ts` | Share of inbound value from the dominant funder |
| `FUNDING` | `NO_INCOMING_FUNDING` | `engines/funding.ts` | No inbound funding observed in the window |
| `COUNTERPARTY` | `REPEATED_COUNTERPARTY` | `engines/counterparty.ts` | Value moved repeatedly with the same address |
| `COUNTERPARTY` | `NO_COUNTERPARTIES` | `engines/counterparty.ts` | No counterparties observed in the window |
| `ENTITY` | `KNOWN_ENTITY_INTERACTION` | `engines/entities.ts` | A counterparty or program matches the curated entity registry |
| `CLUSTER` | `POTENTIAL_CLUSTER_LINK` | `engines/cluster.ts` | Counterparties shared with other analyzed wallets |
| `BEHAVIORAL` | `NARROW_ACTIVITY_WINDOW` | `engines/behavior.ts` | Activity concentrated in few distinct hours |
| `BEHAVIORAL` | `SINGLE_PROTOCOL_USE` | `engines/behavior.ts` | All activity flows through one protocol |
| `TRANSACTION_PATTERN` | `LARGE_TRANSFER_OUTLIER` | `engines/transaction-pattern.ts` | Largest transfer against the wallet's own median |
| `TRANSACTION_PATTERN` | `HIGH_FREQUENCY_ACTIVITY` | `engines/transaction-pattern.ts` | Measured transactions per day |
| `TRANSACTION_PATTERN` | `ODD_HOUR_CONCENTRATION` | `engines/transaction-pattern.ts` | Share of activity in the 00:00–06:00 UTC band against a uniform baseline |
| `TRANSACTION_PATTERN` | `REPEATED_EXACT_AMOUNT` | `engines/transaction-pattern.ts` | Reuse of exact raw transfer amounts |
| `TRANSACTION_PATTERN` | `REGULAR_INTERVAL_ACTIVITY` | `engines/transaction-pattern.ts` | Coefficient of variation of inter-transaction gaps |
| `PUBLIC_ATTRIBUTION` | `PUBLICLY_ATTRIBUTED_COUNTERPARTY` | `engines/public-attribution.ts` | A relationship whose other end carries a public label |
| `PUBLIC_ATTRIBUTION` | `CUSTODIAL_DEPOSIT_ADDRESS_USE` | `engines/public-attribution.ts` | Value moved with a labelled custodial deposit address |
| `IDENTITY_LINKABILITY` | `CONVERGING_LINKABILITY_EVIDENCE` | `engines/linkability.ts` | Independent evidence classes pointing the same way |

## Observed versus inferred evidence

`engines/linkability.ts` splits the categories into two classes, matching
`EdgeObservationClass` in the graph layer:

- **Observed** — `FUNDING`, `COUNTERPARTY`, `ENTITY`, `PUBLIC_ATTRIBUTION`.
  Derived from transfers that exist on chain or from labels that exist in
  public.
- **Inferred** — `BEHAVIORAL`, `CLUSTER`, `TRANSACTION_PATTERN`. Statistical
  similarity.

Two rules follow from the split, and both are enforced in code:

1. A linkability claim requires at least one observed class **and** at least
   two classes in total. One signal is never a convergence claim.
2. Inferred-only evidence is capped (`INFERRED_ONLY_CEILING`, and the
   behavioural confidence cap in `computeConfidence`) so statistical
   similarity alone can never present as a near-identification.

`CONVERGING_LINKABILITY_EVIDENCE` also never reports a confidence above
`0.9`. Correlation is not identity, and the engine is not allowed to imply
otherwise.

## What feeds the score, and what does not

`analyzeLinkability` returns an `identityLinkabilityExposure` value that is
**deliberately not** passed to `scoreWallet`. The scoring engine computes
`identityLinkability` from the same underlying evidence (repeated funding,
repeated counterparty, cluster links, public attribution), so feeding the
aggregate back in would double-count it. The value exists for explanation
surfaces only.

The transaction pattern engine is the opposite case: its four measured
components (`largeTransferExposure`, `highFrequencyExposure`,
`oddHourExposure`, `regularIntervalExposure`) are passed into `scoreWallet`
directly. Before that engine existed, `large_transfers` and `high_frequency`
were both stood in by the same `transactionCount * 0.5` proxy and timing by a
generic behavioral proxy. Those unsupported compatibility shortcuts have
been removed: a missing component now fails closed to zero. Public
attribution likewise defaults to zero evidence when absent; it is never
inferred from protocol use.
