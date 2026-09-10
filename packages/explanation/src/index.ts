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

    case "LARGE_TRANSFER_OUTLIER": {
      const ratio = evidence.ratio ?? 0;
      const largest = evidence.largest_transfer;
      const considered = evidence.transfers_considered ?? 0;
      return `The largest observed transfer (${largest}) is ${ratio}× this wallet's own median across ${considered} transfer(s). Distinctive amounts are easy for an observer to follow from one address to the next.`;
    }

    case "HIGH_FREQUENCY_ACTIVITY": {
      const perDay = evidence.transactions_per_day ?? 0;
      const days = evidence.days_covered ?? 0;
      return `Activity averages ${perDay} transaction(s) per day across ${days} day(s) of history. A distinctive rate narrows the set of wallets that look like this one.`;
    }

    case "ODD_HOUR_CONCENTRATION": {
      const share = Number(evidence.odd_hour_share ?? 0);
      const baseline = Number(evidence.baseline_share ?? 0);
      return `${Math.round(share * 100)}% of transactions fall inside the low-activity UTC band, against ${Math.round(baseline * 100)}% for a wallet active around the clock. This is a timing pattern, not a claim about where the operator is.`;
    }

    case "REPEATED_EXACT_AMOUNT": {
      const occurrences = evidence.occurrences ?? 0;
      const share = Number(evidence.repeated_share ?? 0);
      return `An identical transfer amount recurs ${occurrences} time(s), covering ${Math.round(share * 100)}% of transfers. Matching exact amounts is one of the cheapest ways for an observer to correlate two addresses.`;
    }

    case "REGULAR_INTERVAL_ACTIVITY": {
      const regularity = evidence.interval_regularity ?? 0;
      const gap = evidence.median_interval_hours;
      return `Gaps between transactions are highly regular (regularity ${regularity}, median gap ${gap} hour(s)), which is consistent with scheduled or automated activity rather than ad-hoc use.`;
    }

    case "PUBLICLY_ATTRIBUTED_COUNTERPARTY": {
      const entity = evidence.entity ?? "a labelled address";
      const type = String(evidence.entity_type ?? "entity").toLowerCase();
      const status = String(evidence.label_status ?? "UNVERIFIED").toLowerCase();
      return `One end of this relationship is publicly labelled as ${entity} (${type}, label ${status}). An outside observer can look that address up, which gives them a named anchor next to this wallet — it says nothing about who controls the wallet itself.`;
    }

    case "CUSTODIAL_DEPOSIT_ADDRESS_USE": {
      const entity = evidence.entity ?? "a custodial service";
      return `This wallet moved value with an address publicly labelled as a ${entity} deposit address. Deposit addresses are issued per customer, so an observer can infer that a custodial account sits behind this relationship, but not whose account it is.`;
    }

    case "CONVERGING_LINKABILITY_EVIDENCE": {
      const classes = evidence.converging_classes ?? 0;
      const observed = evidence.observed_classes ?? 0;
      const list = evidence.class_list ?? "";
      return `Linkability evidence appears in ${classes} independent class(es) (${list}), ${observed} of them from directly observed on-chain relationships rather than statistical similarity. Converging evidence narrows the plausible explanations for this activity; it does not establish who controls the wallet.`;
    }

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
