import type { IntelligenceSignal } from "@aegix/types";

export const EXPLANATION_ENGINE_VERSION = "explanation-v1.0.0";

/**
 * Deterministic explanation engine v1, see architecture.md §58.
 * Maps structured signals to neutral, human-readable explanations.
 * Never claims identity, never invents evidence, always explains uncertainty.
 */
export function explainSignal(signal: IntelligenceSignal): string {
  const evidence = Object.fromEntries(
    signal.evidence.map((e) => [e.key, e.value])
  ) as Record<string, string | number | boolean>;

  switch (signal.type) {
    case "REPEATED_FUNDING": {
      const count = evidence.count ?? 0;
      const counterparty = evidence.counterparty ?? "the same address";
      const total = evidence.total_value;
      const period = evidence.period_days;
      const parts = [
        `This wallet received funds from the same address ${count} time${count === 1 ? "" : "s"}`
      ];
      if (period) parts.push(`across ${period} day${period === 1 ? "" : "s"}`);
      parts.push("creating a persistent observable funding relationship that may increase wallet linkability.");
      if (total) parts.push(`Observed total value: ${total}.`);
      return parts.join(" ");
    }

    case "FUNDING_CONCENTRATION": {
      const concentration = evidence.concentration;
      return `A single source provided ${concentration}% of incoming funds, indicating highly concentrated funding that may strengthen a funding relationship.`;
    }

    case "REPEATED_COUNTERPARTY": {
      const count = evidence.count ?? 0;
      const counterparty = evidence.counterparty ?? "the same address";
      return `This wallet interacted with ${counterparty} ${count} time${count === 1 ? "" : "s"}, an observable pattern that may indicate a persistent relationship.`;
    }

    case "KNOWN_ENTITY_INTERACTION": {
      const entity = evidence.entity ?? "a known entity";
      const type = String(evidence.entity_type ?? "entity");
      const count = evidence.interaction_count ?? 0;
      return `This wallet interacted with known ${type.toLowerCase()} ${entity} ${count} time${count === 1 ? "" : "s"}, which may link wallet activity to that entity.`;
    }

    case "POTENTIAL_CLUSTER_LINK": {
      const counterparty = evidence.counterparty ?? "a counterparty";
      const shareCount = evidence.share_count ?? 0;
      return `This wallet shares counterparty ${counterparty} with ${shareCount} other analyzed wallet(s). Shared counterparties may indicate a potential cluster link, but do not prove common ownership.`;
    }

    case "NARROW_ACTIVITY_WINDOW": {
      const hours = evidence.active_hours ?? 0;
      return `Activity concentrates in ${hours} distinct hour(s), a distinctive timing pattern that may contribute to a behavioral fingerprint.`;
    }

    case "SINGLE_PROTOCOL_USE": {
      const protocol = evidence.protocol ?? "a single protocol";
      return `All observed activity flows through ${protocol}, a distinctive behavioral pattern that may increase fingerprintability.`;
    }

    case "NO_INCOMING_FUNDING":
      return "No incoming transfers were observed in the analyzed window, so funding relationships could not be established.";

    case "NO_COUNTERPARTIES":
      return "No transfer counterparties were observed in the analyzed window, so counterparty relationships could not be established.";

    default:
      return `${signal.title}. ${signal.summary}`;
  }
}

/** Explains an attack path from its node labels. */
export function explainPath(path: { nodes: Array<{ type: string; label: string }>; pathScore: number; confidenceScore: number }): string {
  const chain = path.nodes.map((n) => n.label).join(" → ");
  return (
    `This path (${chain}) creates potential linkability between the target wallet and the endpoint through ${path.nodes.length - 1} observable hop(s). ` +
    `Path strength ${Math.round(path.pathScore * 100) / 100}, confidence ${Math.round(path.confidenceScore * 100)}%. ` +
    `These are observable relationships only and do not establish ownership.`
  );
}
