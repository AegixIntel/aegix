import { SectionLabel, EditorialHeading, StatusBadge } from "@/components/ui/primitives";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Security",
  description: "AEGIX security model — wallet-only authentication, message signing, session security, and webhook signatures."
};

const ITEMS = [
  { t: "Wallet-only authentication", b: "AEGIX authenticates by asking you to sign a challenge with your Solana wallet. There is no email/password login and no third-party identity provider." },
  { t: "signMessage, never a transaction", b: "Signing the authentication challenge costs no SOL and does not create a blockchain transaction. Your private keys never leave your wallet." },
  { t: "No private keys", b: "AEGIX never requests your private keys or seed phrase. Only your public address and a signed message are ever sent to the server." },
  { t: "Domain-bound challenges", b: "Authentication challenges are bound to the AEGIX domain and carry a nonce and expiry, which prevents replay of a captured signature." },
  { t: "Session security", b: "A session token is stored locally and verified server-side on every request. Wallet account switching invalidates the prior session." },
  { t: "API key handling", b: "Developer API keys are shown once at creation, stored only as a one-way hash, and scoped to specific permissions. They must never be sent in URLs." },
  { t: "Webhook signatures", b: "Webhook deliveries are signed with an HMAC-SHA256 signature using a per-endpoint secret, so consumers can verify authenticity and detect tampering." }
];

export default function SecurityPage() {
  return (
    <div className="container-narrow py-20 md:py-28">
      <SectionLabel>Security</SectionLabel>
      <EditorialHeading as="h1" className="mt-6">
        Trust is the product.
      </EditorialHeading>
      <p className="mt-8 editorial-body">
        AEGIX is built so that authentication never touches your funds and your intelligence stays attributable
        only to your wallet.
      </p>

      <div className="mt-14 grid gap-x-12 gap-y-0 md:grid-cols-2">
        {ITEMS.map((i) => (
          <div key={i.t} className="border-t border-white/10 py-6">
            <h2 className="font-display text-lg font-semibold text-marble">{i.t}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{i.b}</p>
          </div>
        ))}
      </div>

      <div className="mt-16 border-t border-white/10 pt-10">
        <SectionLabel>Practical guidance</SectionLabel>
        <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
          <li>• Treat signatures like passwords — never share a signed authentication message.</li>
          <li>• Store developer API keys in a secrets manager, never in client code or URLs.</li>
          <li>• Verify every webhook signature before acting on a delivery.</li>
          <li>• Webhook endpoints must not accept arbitrary redirects; AEGIX blocks private/internal network targets.</li>
        </ul>
        <p className="mt-6 text-xs text-muted-2">
          The notification email is a delivery destination only — it is never a login credential.
        </p>
      </div>
    </div>
  );
}
