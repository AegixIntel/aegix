/**
 * Relationships across more than two series, see
 * docs/milestone-d14-rewind-discovery.md §4c.
 *
 * The engine tests pairs. A cluster is what several of its pairwise
 * discoveries add up to: the discoveries one scan stamped that are joined by
 * a shared series. "A and B" and "B and C", first found by the same run, are
 * one cluster over A, B and C.
 *
 * A cluster is a reading of discoveries already on record. It is not a joint
 * test: nothing here says the series move as one, only that each link passed
 * its own test in the same run. It adds no hypothesis and no Discovery ID.
 */

export const CLUSTER_MIN_SERIES = 3;

/** One discovery, as a link between two series. */
export interface ClusterLink {
  id: string;
  /** The scan that stamped it. Only links of one run are joined. */
  runId: string;
  seriesA: string;
  seriesB: string;
  lagHours: number;
  direction: string;
  status: string;
  detectedAt: string;
  r: number | null;
}

export interface RelationshipCluster {
  /** The Discovery ID of its earliest link. A cluster has no ID of its own. */
  key: string;
  runId: string;
  /** Series keys, the most connected first. */
  series: string[];
  links: ClusterLink[];
  firstDetectedAt: string;
  lastDetectedAt: string;
}

/**
 * Groups links into clusters: connected by a shared series, within one run.
 * A discovery that later failed its confirmation joins nothing.
 */
export function relationshipClusters(links: readonly ClusterLink[], minSeries = CLUSTER_MIN_SERIES): RelationshipCluster[] {
  const byRun = new Map<string, ClusterLink[]>();
  for (const link of links) {
    if (link.status === "NOT_CONFIRMED") continue;
    byRun.set(link.runId, [...(byRun.get(link.runId) ?? []), link]);
  }

  const clusters: RelationshipCluster[] = [];
  for (const [runId, runLinks] of byRun) {
    const parent = new Map<string, string>();
    const find = (key: string): string => {
      let root = key;
      while (parent.get(root) !== root) root = parent.get(root)!;
      parent.set(key, root);
      return root;
    };
    for (const link of runLinks) {
      for (const key of [link.seriesA, link.seriesB]) if (!parent.has(key)) parent.set(key, key);
      parent.set(find(link.seriesA), find(link.seriesB));
    }

    const members = new Map<string, ClusterLink[]>();
    for (const link of runLinks) {
      const root = find(link.seriesA);
      members.set(root, [...(members.get(root) ?? []), link]);
    }
    for (const group of members.values()) {
      const degree = new Map<string, number>();
      for (const link of group) for (const key of [link.seriesA, link.seriesB]) degree.set(key, (degree.get(key) ?? 0) + 1);
      if (degree.size < minSeries) continue;
      const ordered = [...group].sort((a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt) || a.id.localeCompare(b.id, undefined, { numeric: true }));
      clusters.push({
        key: ordered[0]!.id,
        runId,
        series: [...degree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => key),
        links: ordered,
        firstDetectedAt: ordered[0]!.detectedAt,
        lastDetectedAt: ordered.at(-1)!.detectedAt
      });
    }
  }
  // Newest first, like the discoveries themselves.
  return clusters.sort((a, b) => Date.parse(b.firstDetectedAt) - Date.parse(a.firstDetectedAt) || b.series.length - a.series.length);
}
