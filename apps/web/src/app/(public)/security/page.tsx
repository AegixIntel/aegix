import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Security",
  description: "AEGIX security model: wallet-only authentication, message signing, session security, and webhook signatures."
};

const items = [
  {
    title: "Wallet-only authentication",
    body: "AEGIX authenticates by asking you to sign a challenge with your Solana wallet. There is no email/password login, no SMS, and no third-party identity provider."
  },
  {
    title: "signMessage, never a transaction",
    body: "Signing the authentication challenge costs no SOL and does not create a blockchain transaction. Your private keys never leave your wallet."
  },
  {
    title: "No private keys",
    body: "AEGIX never requests your private keys or seed phrase. Only your public address and a signed message are ever sent to the server."
  },
  {
    title: "Domain-bound challenges",
    body: "Authentication challenges are bound to the AEGIX domain and carry a nonce and expiry, which prevents replay of a previously captured signature."
  },
  {
    title: "Session security",
    body: "A session token is stored locally and verified server-side on every request. Wallet account switching invalidates the prior session."
  },
  {
    title: "API key handling",
    body: "Developer API keys are shown once at creation, stored only as a one-way hash, and scoped to specific permissions. They must never be sent in URLs."
  },
  {
    title: "Webhook signatures",
    body: "Webhook deliveries are signed with an HMAC-SHA256 signature using a per-endpoint secret, so consumers can verify authenticity and detect tampering."
  }
];

export default function SecurityPage() {
  return (
    <div className="container-page py-16">
      <div className="mx-auto max-w-3xl text-center">
        <p className="marketing-eyebrow">Security</p>
        <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight text-marble md:text-6xl">
          Trust is the product.
        </h1>
        <p className="marketing-body mt-6">
          AEGIX is built so that authentication never touches your funds and your intelligence stays
          attributable only to your wallet.
        </p>
      </div>

      <section className="mt-16 grid gap-4 md:grid-cols-2">
        {items.map((i) => (
          <div key={i.title} className="card-surface p-6">
            <h2 className="font-display text-lg font-semibold text-marble">{i.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{i.body}</p>
          </div>
        ))}
      </section>

      <div className="mt-16 rounded-2xl border border-white/10 bg-white/[0.03] p-8">
        <h2 className="font-display text-xl font-semibold text-marble">Practical guidance</h2>
        <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
          <li>• Treat signatures like passwords — never share a signed authentication message.</li>
          <li>• Store developer API keys in a secrets manager, never in client code or URLs.</li>
          <li>• Verify every webhook signature before acting on a delivery.</li>
          <li>• Webhook endpoints must not accept arbitrary redirects; AEGIX blocks private/internal network targets.</li>
        </ul>
        <p className="mt-6 text-xs text-muted-foreground/70">
          The notification email is a delivery destination only — it is never a login credential.
        </p>
      </div>
    </div>
  );
}
