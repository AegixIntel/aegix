import type { Address, Chain, Confidence, Timestamp } from "./common.js";

export type EntityType =
  | "CENTRALIZED_EXCHANGE"
  | "DEX"
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
}

export interface EntityMatch {
  entity: Entity;
  address: Address;
  confidence: Confidence;
}
