import { DocHeading, DocSection, DocList, DocCode, DocNote } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Developer API Authentication" };

export default function ApiAuthDocPage() {
  return (
    <div>
      <DocHeading eyebrow="Developer API" title="Authentication" lead="Authenticate your requests with a scoped API key." />

      <DocSection title="API key format">
        <p>Keys are prefixed <code className="font-mono">aegix_live_</code> followed by a random base58 string. Send them in the <code className="font-mono">Authorization</code> header, never in a URL.</p>
        <DocCode>{`Authorization: Bearer aegix_live_<base58>`}</DocCode>
      </DocSection>

      <DocSection title="Create a key">
        <p>Keys are created in the developer portal. Each key carries a set of scopes and an optional expiration.</p>
        <DocList items={[
          "intelligence:read — read wallet & compare intelligence",
          "usage:read — read your usage/quota summary"
        ]} />
      </DocSection>

      <DocSection title="Secret handling">
        <DocList items={[
          "The full key is shown exactly once at creation and rotation.",
          "Only a one-way hash is stored server-side.",
          "AEGIX never retrieves the plaintext key again.",
          "Rotate a key to invalidate the old one immediately."
        ]} />
      </DocSection>

      <DocNote>
        Never log, commit, or expose API keys. Treat them like passwords.
      </DocNote>
    </div>
  );
}
