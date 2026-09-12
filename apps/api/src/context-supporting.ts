import { createHash } from "node:crypto";
import { createFundingPathRepo, createCorrelationRepo, createIntelligenceRepo, type Sql } from "@aegix/database";
import type { ContextSupportingEvidence } from "@aegix/context";

/** Reads persisted D1–D7 evidence only. Wallet-level records disclose their separate window. */
export async function loadContextSupporting(sql: Sql, walletId: string, address: string, analysisId: string): Promise<ContextSupportingEvidence[]> {
  const [funding, paths, correlations] = await Promise.all([
    createFundingPathRepo(sql).listForTarget(walletId),
    createIntelligenceRepo(sql).pathsForAnalysis(analysisId),
    createCorrelationRepo(sql).listForWallet(address, 10)
  ]);
  const records: ContextSupportingEvidence[] = [];
  for (const path of funding.slice(0, 10)) records.push({
    id: `cov:provenance:${createHash("sha256").update(JSON.stringify(path.path)).digest("hex").slice(0, 20)}`,
    category: "FUNDING_PROVENANCE", title: "Observed funding provenance path",
    description: "A deterministic funding path was persisted. A path does not identify the wallet owner or establish the ultimate source beyond its traversal bound.",
    confidence: Number(path.path_confidence), sourceEngine: "funding-provenance", engineVersion: path.engine_version,
    evidence: [{ key: "terminusAddress", value: path.terminus_address, label: "Observed terminus" },
      { key: "terminusType", value: path.terminus_type, label: "Terminus classification" },
      { key: "path", value: JSON.stringify(path.path), label: "Persisted path" }],
    observedAt: path.created_at, analysisId: null,
    limitations: ["Wallet-level persisted evidence can come from a separate bounded analysis window; its observation time is reported separately."] });
  for (const path of paths.slice(0, 10)) records.push({
    id: `cov:graph:${analysisId}:${path.rank}`, category: "GRAPH_PATH", title: "Persisted graph path",
    description: "A path in the existing attack graph connects observed or inferred evidence. Derived paths are supporting context and are not additional independent indicators.",
    confidence: Number(path.confidence_score), sourceEngine: "graph", engineVersion: path.engine_version ?? "unknown",
    evidence: [{ key: "pathType", value: path.path_type, label: "Path type" },
      { key: "nodes", value: JSON.stringify(path.nodes_json), label: "Persisted nodes" },
      { key: "edges", value: JSON.stringify(path.edges_json), label: "Persisted edges" }],
    observedAt: path.created_at, analysisId,
    limitations: ["Graph paths derive from existing evidence. Correlation and inferred edges do not prove ownership."] });
  for (const correlation of correlations) {
    if (!Array.isArray(correlation.evidence_families) || !correlation.evidence_families.length || Number(correlation.confidence) <= 0) continue;
    records.push({ id: `cov:correlation:${correlation.wallet_a}:${correlation.wallet_b}`, category: "CORRELATION",
      title: "Persisted correlation evidence", description: "The deterministic correlation engine recorded overlapping evidence. Correlation does not prove common ownership or identity.",
      confidence: Number(correlation.confidence), sourceEngine: "correlation", engineVersion: correlation.engine_version,
      evidence: [{ key: "walletA", value: correlation.wallet_a, label: "Compared wallet A" }, { key: "walletB", value: correlation.wallet_b, label: "Compared wallet B" },
        { key: "evidenceFamilies", value: JSON.stringify(correlation.evidence_families), label: "Persisted evidence families" }],
      observedAt: correlation.updated_at, analysisId: null,
      limitations: ["This comparison is a separate persisted observation, not a fresh analysis or independent indicator.",
        ...(Array.isArray(correlation.limitations) ? correlation.limitations.filter((value): value is string => typeof value === "string") : [])] });
  }
  return records;
}
