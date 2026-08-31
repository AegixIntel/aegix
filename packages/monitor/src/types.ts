import type { AppConfig } from "@aegix/config";
import type { AegixQueues } from "@aegix/queue";
import type { Sql } from "@aegix/database";
import type { AegixLogger } from "@aegix/logging";

/** Minimal processor context used by the monitor pipeline. */
export interface ProcessorContext {
  config: AppConfig;
  sql: Sql;
  logger: AegixLogger;
  queues: AegixQueues;
}
