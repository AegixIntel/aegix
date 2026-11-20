/**
 * Observations about one EVM wallet, read from its transfers in the indexed
 * window. Deliberately no score: each signal is a count or a list a reader can
 * check against the transfers themselves.
 *
 * Address poisoning: an attacker sends a zero or dust transfer from an address
 * whose first and last characters match one the victim really pays, hoping the
 * victim copies it from history. Token contracts can also emit a zero-amount
 * Transfer *from* the victim to the look-alike, which reads as outgoing. A
 * counterparty is "genuine" here only when the wallet itself sent the
 * transaction and moved a non-zero amount to it; any other counterparty that
 * imitates a genuine one is listed.
 */
import { ZERO_ADDRESS, type TransferKind } from "./evm-transfers.js";

export interface SignalTransfer {
  tx_id: string;
  ordinal: number;
  height: number;
  kind: TransferKind;
  token: string | null;
  sender: string;
  recipient: string;
  amount_atomic: string | null;
  /** Who sent the transaction that carried this transfer. */
  tx_sender: string;
}

export interface Counterparty {
  address: string;
  incoming: number;
  outgoing: number;
  nativeIn: string;
  nativeOut: string;
  firstHeight: number;
  lastHeight: number;
}

export interface LookAlike {
  address: string;
  /** The genuine counterparty it imitates. */
  imitates: string;
  tx_id: string;
  height: number;
  kind: TransferKind;
  direction: "IN" | "OUT";
  zeroAmount: boolean;
}

export interface WalletSignals {
  sample: { transfers: number; truncated: boolean; fromHeight: number | null; toHeight: number | null };
  activity: { incoming: number; outgoing: number; self: number; nativeIn: string; nativeOut: string; tokenContracts: number;
    zeroAmountIncoming: number };
  /** Earliest incoming native transfer in the sample; not the wallet's first funding ever. */
  earliestFunding: { sender: string; height: number; tx_id: string; amount_atomic: string } | null;
  counterparties: Counterparty[];
  lookAlikes: LookAlike[];
}

const COUNTERPARTY_LIMIT = 10;
/** Characters a wallet UI typically shows at each end of an address. */
const VISIBLE = 4;
const fingerprint = (address: string) => `${address.slice(2, 2 + VISIBLE)}…${address.slice(-VISIBLE)}`;

export function walletSignals(wallet: string, transfers: SignalTransfer[], truncated: boolean): WalletSignals {
  let incoming = 0, outgoing = 0, self = 0, zeroAmountIncoming = 0;
  let nativeIn = 0n, nativeOut = 0n;
  const tokens = new Set<string>();
  const parties = new Map<string, { incoming: number; outgoing: number; nativeIn: bigint; nativeOut: bigint; first: number; last: number }>();
  const genuine = new Map<string, string>();
  let earliest: WalletSignals["earliestFunding"] = null;

  for (const t of transfers) {
    const out = t.sender === wallet;
    const into = t.recipient === wallet;
    if (!out && !into) continue;
    if (t.token) tokens.add(t.token);
    const amount = t.amount_atomic === null ? null : BigInt(t.amount_atomic);
    const zero = amount === 0n;
    if (out && into) { self += 1; continue; }
    const native = t.kind === "NATIVE" ? amount! : 0n;
    if (into) {
      incoming += 1; nativeIn += native;
      if (zero && t.kind === "ERC20") zeroAmountIncoming += 1;
      if (t.kind === "NATIVE" && (!earliest || t.height < earliest.height || (t.height === earliest.height && t.tx_id < earliest.tx_id))) {
        earliest = { sender: t.sender, height: t.height, tx_id: t.tx_id, amount_atomic: t.amount_atomic! };
      }
    } else {
      outgoing += 1; nativeOut += native;
      if (t.tx_sender === wallet && !zero) genuine.set(fingerprint(t.recipient), t.recipient);
    }
    const other = out ? t.recipient : t.sender;
    if (other === ZERO_ADDRESS) continue;
    const party = parties.get(other) ?? { incoming: 0, outgoing: 0, nativeIn: 0n, nativeOut: 0n, first: t.height, last: t.height };
    if (into) { party.incoming += 1; party.nativeIn += native; } else { party.outgoing += 1; party.nativeOut += native; }
    party.first = Math.min(party.first, t.height);
    party.last = Math.max(party.last, t.height);
    parties.set(other, party);
  }

  const lookAlikes: LookAlike[] = [];
  for (const t of transfers) {
    const out = t.sender === wallet;
    if (out === (t.recipient === wallet)) continue;
    const other = out ? t.recipient : t.sender;
    const imitated = genuine.get(fingerprint(other));
    if (imitated && imitated !== other) {
      lookAlikes.push({ address: other, imitates: imitated, tx_id: t.tx_id, height: t.height, kind: t.kind,
        direction: out ? "OUT" : "IN", zeroAmount: t.amount_atomic === "0" });
    }
  }

  const heights = transfers.map(t => t.height);
  return {
    sample: { transfers: transfers.length, truncated,
      fromHeight: heights.length ? Math.min(...heights) : null, toHeight: heights.length ? Math.max(...heights) : null },
    activity: { incoming, outgoing, self, nativeIn: nativeIn.toString(), nativeOut: nativeOut.toString(),
      tokenContracts: tokens.size, zeroAmountIncoming },
    earliestFunding: earliest,
    counterparties: [...parties.entries()]
      .sort(([a, x], [b, y]) => (y.incoming + y.outgoing) - (x.incoming + x.outgoing) || x.first - y.first || (a < b ? -1 : 1))
      .slice(0, COUNTERPARTY_LIMIT)
      .map(([address, p]) => ({ address, incoming: p.incoming, outgoing: p.outgoing, nativeIn: p.nativeIn.toString(),
        nativeOut: p.nativeOut.toString(), firstHeight: p.first, lastHeight: p.last })),
    lookAlikes
  };
}
