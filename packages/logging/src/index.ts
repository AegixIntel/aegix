/**
 * Structured JSON logging, see milestone D2 §54-§57.
 *
 * Every record is a single JSON line with level, service, timestamp and
 * arbitrary context. Child loggers bind trace ids (request_id, analysis_id,
 * job_id) and wallet privacy fields (wallet_short / wallet_hash) so a single
 * analysis is traceable across API -> queue -> worker -> engines -> database
 * without dumping full wallet addresses into every log line.
 */

import { createHash } from "node:crypto";
import type { AppConfig } from "@aegix/config";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_ORDER: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5
};

export interface LogContext {
  [key: string]: unknown;
}

export interface AegixLogger {
  fatal(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
  trace(msg: string, ctx?: LogContext): void;
  child(bindings: LogContext): AegixLogger;
}

export interface LoggerOptions {
  level?: LogLevel;
  service?: string;
}

/**
 * Short, log-safe wallet reference, see D2 §55.
 * `wallet_short` is a bounded prefix; `wallet_hash` is a stable sha256 digest
 * for correlation. Full addresses are only available in controlled contexts.
 */
export function walletRef(address: string): { walletShort: string; walletHash: string } {
  return {
    walletShort: address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address,
    walletHash: createHash("sha256").update(address).digest("hex").slice(0, 16)
  };
}

/**
 * Creates a structured JSON logger writing one object per line to stdout.
 * Filters by level (LOG_LEVEL). No external dependencies.
 */
export function createLogger(config: Pick<AppConfig, "LOG_LEVEL">, options: LoggerOptions = {}): AegixLogger {
  const threshold = LEVEL_ORDER[options.level ?? config.LOG_LEVEL] ?? LEVEL_ORDER.info;
  const service = options.service ?? "aegix";

  function write(level: LogLevel, msg: string, ctx?: LogContext): void {
    if (LEVEL_ORDER[level] > threshold) return;
    const record = {
      level,
      service,
      msg,
      timestamp: new Date().toISOString(),
      ...ctx
    };
    const line = JSON.stringify(record);
    if (level === "fatal" || level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  function makeLogger(bindings: LogContext): AegixLogger {
    const base = { ...bindings };
    return {
      fatal: (msg, ctx) => write("fatal", msg, { ...base, ...ctx }),
      error: (msg, ctx) => write("error", msg, { ...base, ...ctx }),
      warn: (msg, ctx) => write("warn", msg, { ...base, ...ctx }),
      info: (msg, ctx) => write("info", msg, { ...base, ...ctx }),
      debug: (msg, ctx) => write("debug", msg, { ...base, ...ctx }),
      trace: (msg, ctx) => write("trace", msg, { ...base, ...ctx }),
      child: (childBindings) => makeLogger({ ...base, ...childBindings })
    };
  }

  return makeLogger({});
}
