import assert from "node:assert/strict";
import { test } from "node:test";
import { relationshipClusters, type ClusterLink } from "./cluster.js";

function link(id: number, runId: string, seriesA: string, seriesB: string, extra: Partial<ClusterLink> = {}): ClusterLink {
  return { id: `AEX-${id}`, runId, seriesA, seriesB, lagHours: 0, direction: "POSITIVE", status: "CANDIDATE",
    detectedAt: new Date(Date.UTC(2026, 9, 6, 0, 0, id)).toISOString(), r: 0.5, ...extra };
}

test("links of one run that share a series are one cluster, the most connected series first", () => {
  const clusters = relationshipClusters([
    link(1, "7", "a", "b"), link(2, "7", "b", "c"), link(3, "7", "b", "d"),
    link(4, "7", "x", "y")
  ]);
  assert.equal(clusters.length, 1, "a lone pair is a discovery, not a cluster");
  assert.equal(clusters[0]!.key, "AEX-1");
  assert.deepEqual(clusters[0]!.series, ["b", "a", "c", "d"]);
  assert.deepEqual(clusters[0]!.links.map((l) => l.id), ["AEX-1", "AEX-2", "AEX-3"]);
  assert.equal(clusters[0]!.firstDetectedAt, "2026-10-06T00:00:01.000Z");
  assert.equal(clusters[0]!.lastDetectedAt, "2026-10-06T00:00:03.000Z");
});

test("links found by different runs are not joined", () => {
  assert.equal(relationshipClusters([link(1, "7", "a", "b"), link(2, "8", "b", "c")]).length, 0);
});

test("a discovery that failed its confirmation joins nothing", () => {
  const clusters = relationshipClusters([
    link(1, "7", "a", "b"), link(2, "7", "b", "c", { status: "NOT_CONFIRMED" }), link(3, "7", "c", "d")
  ]);
  assert.equal(clusters.length, 0, "without the failed link there are two lone pairs");
});

test("clusters are listed newest first", () => {
  const clusters = relationshipClusters([
    link(1, "7", "a", "b"), link(2, "7", "b", "c"),
    link(11, "8", "p", "q"), link(12, "8", "q", "r")
  ]);
  assert.deepEqual(clusters.map((c) => c.key), ["AEX-11", "AEX-1"]);
});
