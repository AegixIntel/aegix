import type { Address, Chain, Confidence, Timestamp } from "./common.js";

export type EntityType =
  | "CENTRALIZED_EXCHANGE"
  | "DEX"
  | "LENDING"
  | "NFT_MARKETPLACE"
  | "STAKING"
  | "INFRASTRUCTURE"
  | "BRIDGE"
  | "PROTOCOL"
  | "MARKETPLACE"
  | "CUSTODIAN"
  | "PAYMENT_PROVIDER"
  | "SERVICE"
  | "PUBLIC_ORGANIZATION"
  | "KNOWN_WALLET"
  | "UNKNOWN_CLUSTER";

export type EntityStatus = "UNVERIFIED" | "PROBABLE" | "VERIFIED" | "DISPUTED" | "DEPRECATED";

/** Address role within an entity, see docs/d5-block2.md (D5-F §22). */
export type EntityAddressRole =
  | "PROGRAM"
  | "ROUTER"
  | "TREASURY"
  | "VAULT"
  | "HOT_WALLET"
  | "DEPOSIT"
  | "ESCROW"
  | "UNKNOWN_ROLE";

export interface Entity {
  id: string;
  name: string;
  entityType: EntityType;
  description: string | null;
  status: EntityStatus;
  defaultConfidence: Confidence;
  sourceType: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface EntityAddress {
  id: string;
  entityId: string;
  chain: Chain;
  address: Address;
  label: string | null;
  confidence: Confidence;
  evidenceSource: string | null;
  firstVerifiedAt: Timestamp | null;
  lastVerifiedAt: Timestamp | null;
  status: EntityStatus;
  /** D5-F §22: role of this address inside the entity (PROGRAM/ROUTER/…). */
  addressRole: EntityAddressRole;
  /** D5-F §26: when the address was deprecated/disputed, if ever. */
  deprecatedAt: Timestamp | null;
  /** Free-form notes (provenance detail). */
  notes: string | null;
}

export interface EntityMatch {
  entity: Entity;
  address: Address;
  confidence: Confidence;
}
