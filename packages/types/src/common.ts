/**
 * Shared primitive types used across the AEGIX platform.
 */

export type Chain = "solana";

export type Address = string;

/** 0.00 – 1.00 */
export type Confidence = number;

/** 0 – 100 */
export type ScoreValue = number;

/** Stable, versioned identifier for a scoring/analysis engine release. */
export type EngineVersion = string;

export type Timestamp = string; // ISO 8601

/** Stable error codes exposed by the API. */
export type ErrorCode =
  | "INVALID_WALLET"
  | "CHAIN_DATA_UNAVAILABLE"
  | "RPC_RATE_LIMITED"
  | "RPC_TIMEOUT"
  | "INSUFFICIENT_HISTORY"
  | "ANALYSIS_TIMEOUT"
  | "PARSER_FAILURE"
  | "DATABASE_FAILURE"
  | "INTERNAL_ERROR";

export interface ApiError {
  code: ErrorCode;
  message: string;
  requestId: string;
}
