import type {
  EntityAddress,
  EntityAddressRole,
  EntityMatch,
  EntityStatus,
  EntityType,
  IntelligenceSignal,
  NormalizedTransfer
} from "@aegix/types";
import { makeSignal } from "../signals.js";
import type { EntityRegistry } from "./entities.js";

export const PUBLIC_ATTRIBUTION_ENGINE_VERSION = "public-attribution-v1.0.0";

/**
 * How much a *publicly documented* label on a counterparty contributes to
 * attribution exposure, by entity type.
 *
 * The distinction this engine exists to make: interacting with a DEX program
 * attributes nothing about the operator — everyone uses the same program —
 * while receiving value from a publicly named wallet, or depositing to a
 * custodial address, creates a surface an outside observer can look up.
 * Protocol-shaped entities therefore score low here; they are already
 * reported as ENTITY exposure.
 */
const TYPE_BASE: Record<EntityType, number> = {
  PUBLIC_ORGANIZATION: 75,
  CENTRALIZED_EXCHANGE: 70,
  CUSTODIAN: 70,
  KNOWN_WALLET: 65,
  PAYMENT_PROVIDER: 60,
  SERVICE: 35,
  MARKETPLACE: 25,
  NFT_MARKETPLACE: 25,
  BRIDGE: 25,
  DEX: 15,
  LENDING: 15,
  STAKING: 15,
  PROTOCOL: 15,
  INFRASTRUCTURE: 15,
  UNKNOWN_CLUSTER: 10
};

/**
 * Deposit addresses are assigned per customer, so an observer can infer that
 * *a* custodial account exists behind them — the strongest publicly
 * observable attribution surface in this model.
 */
const ROLE_MULTIPLIER: Record<EntityAddressRole, number> = {
  DEPOSIT: 1.25,
  TREASURY: 1.1,
  HOT_WALLET: 1.0,
  UNKNOWN_ROLE: 1.0,
  ESCROW: 0.8,
  VAULT: 0.8,
  ROUTER: 0.8,
  PROGRAM: 0.8
};

/** A label AEGIX has not verified attributes correspondingly less. */
const STATUS_MULTIPLIER: Record<EntityStatus, number> = {
  VERIFIED: 1.0,
  PROBABLE: 0.7,
  UNVERIFIED: 0.4,
  DISPUTED: 0.25,
  DEPRECATED: 0.2
};

/** Value moved directly with the address attributes more than calling its program. */
const DIRECT_COUNTERPARTY_MULTIPLIER = 1.0;
const PROGRAM_ONLY_MULTIPLIER = 0.6;
/** A citable public source makes the label independently checkable. */
const CITABLE_SOURCE_BONUS = 1.1;

/** Below this weight an attribution is recorded but not raised as a signal. */
const SIGNAL_WEIGHT_THRESHOLD = 40;
/** Each additional independent attribution adds a little, never compounds. */
const ADDITIONAL_ATTRIBUTION_BONUS = 5;
const MAX_ATTRIBUTION_SIGNALS = 5;

export interface PublicAttributionAnalysisInput {
  walletAddress: string;
  transfers: NormalizedTransfer[];
  /** Matches from the entity engine, reused so matching logic lives in one place. */
  matches: EntityMatch[];
  registry: EntityRegistry;
}

export interface PublicAttributionRecord {
  address: string;
  entityName: string;
  entityType: EntityType;
  entityStatus: EntityStatus;
  addressRole: EntityAddressRole;
  /** Public, citable provenance for the label, when the registry has one. */
  evidenceSource: string | null;
  /** The wallet moved value directly with this address. */
  directCounterparty: boolean;
  /** 0-100 contribution of this single attribution. */
  weight: number;
  confidence: number;
}

export interface PublicAttributionAnalysisResult {
  signals: IntelligenceSignal[];
  attributions: PublicAttributionRecord[];
  /** 0-100, consumed as `identityLinkability.public_attribution` by scoring. */
  publicAttributionExposure: number;
}

/**
 * Public attribution engine — the PUBLIC_ATTRIBUTION signal category and the
 * `public_attribution` component of identity linkability (architecture.md §26).
 *
 * It answers one question: which of this wallet's observable relationships
 * touch an address that is *publicly labelled*, and therefore lets an outside
 * observer attach a name to one end of the relationship. It never asserts
 * ownership of the analyzed wallet.
 */
export function analyzePublicAttribution(
  input: PublicAttributionAnalysisInput
): PublicAttributionAnalysisResult {
  const { walletAddress, transfers, matches, registry } = input;

  const addressRows = new Map<string, EntityAddress>();
  for (const row of registry.addresses) {
    addressRows.set(row.address, row);
  }

  const directCounterparties = new Set<string>();
  for (const t of transfers) {
    if (t.fromAddress === walletAddress) directCounterparties.add(t.toAddress);
    if (t.toAddress === walletAddress) directCounterparties.add(t.fromAddress);
  }

  const attributions: PublicAttributionRecord[] = [];
  for (const match of matches) {
    const row = addressRows.get(match.address);
    const addressRole: EntityAddressRole = row?.addressRole ?? "UNKNOWN_ROLE";
    // An address-level status overrides the entity default: a deprecated
    // address on a verified entity must not attribute at full strength.
    const entityStatus: EntityStatus = row?.status ?? match.entity.status;
    const evidenceSource = row?.evidenceSource ?? null;
    const directCounterparty = directCounterparties.has(match.address);

    const weight = clamp(
      Math.round(
        (TYPE_BASE[match.entity.entityType] ?? 10) *
          (ROLE_MULTIPLIER[addressRole] ?? 1.0) *
          (STATUS_MULTIPLIER[entityStatus] ?? 0.4) *
          (directCounterparty ? DIRECT_COUNTERPARTY_MULTIPLIER : PROGRAM_ONLY_MULTIPLIER) *
          (evidenceSource ? CITABLE_SOURCE_BONUS : 1.0)
      ),
      0,
      100
    );

    attributions.push({
      address: match.address,
      entityName: match.entity.name,
      entityType: match.entity.entityType,
      entityStatus,
      addressRole,
      evidenceSource,
      directCounterparty,
      weight,
      confidence: clamp(match.confidence * (STATUS_MULTIPLIER[entityStatus] ?? 0.4), 0, 1)
    });
  }

  attributions.sort((a, b) => b.weight - a.weight || a.address.localeCompare(b.address));

  const signalWorthy = attributions.filter((a) => a.weight >= SIGNAL_WEIGHT_THRESHOLD);
  const publicAttributionExposure =
    signalWorthy.length === 0
      ? 0
      : clamp(
          signalWorthy[0]!.weight + ADDITIONAL_ATTRIBUTION_BONUS * (signalWorthy.length - 1),
          0,
          100
        );

  const signals: IntelligenceSignal[] = [];
  for (const a of signalWorthy.slice(0, MAX_ATTRIBUTION_SIGNALS)) {
    const custodialDeposit =
      a.addressRole === "DEPOSIT" &&
      (a.entityType === "CENTRALIZED_EXCHANGE" || a.entityType === "CUSTODIAN");

    signals.push(
      makeSignal(
        custodialDeposit
          ? {
              type: "CUSTODIAL_DEPOSIT_ADDRESS_USE",
              category: "PUBLIC_ATTRIBUTION",
              severity: a.weight,
              confidence: a.confidence,
              title: `Deposit address used at ${a.entityName}`,
              summary: `This wallet moved value with an address publicly labelled as a ${a.entityName} deposit address. Deposit addresses are issued per customer, so an observer can infer that a custodial account sits behind this relationship — not who holds it.`,
              evidence: evidenceFor(a)
            }
          : {
              type: "PUBLICLY_ATTRIBUTED_COUNTERPARTY",
              category: "PUBLIC_ATTRIBUTION",
              severity: a.weight,
              confidence: a.confidence,
              title: `Publicly labelled counterparty: ${a.entityName}`,
              summary: `One end of this relationship carries a public label (${a.entityName}, ${a.entityType}). An outside observer can look the address up, which gives them a named anchor next to this wallet.`,
              evidence: evidenceFor(a)
            },
        PUBLIC_ATTRIBUTION_ENGINE_VERSION
      )
    );
  }

  return { signals, attributions, publicAttributionExposure };
}

function evidenceFor(a: PublicAttributionRecord) {
  return [
    { key: "entity", value: a.entityName, label: "Entity" },
    { key: "entity_type", value: a.entityType, label: "Type" },
    { key: "address_role", value: a.addressRole, label: "Address role" },
    { key: "label_status", value: a.entityStatus, label: "Label status" },
    { key: "relationship", value: a.directCounterparty ? "DIRECT_TRANSFER" : "PROGRAM_INTERACTION", label: "Relationship" },
    { key: "evidence_source", value: a.evidenceSource ?? "none", label: "Public source" }
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
