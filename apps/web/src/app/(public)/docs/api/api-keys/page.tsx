import { DocHeading, DocSection, DocList, DocCode } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "API Keys" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Developer API" title="API Keys" lead="Create, scope, revoke, and rotate keys." />
      <DocSection title="Create">
        <p>Create a key with a name, a set of scopes, and an optional expiration. The plaintext key is returned exactly once.</p>
      </DocSection>
      <DocSection title="List">
        <DocCode>{`GET /v1/developer/keys
Authorization: Bearer <wallet-session-token>`}</DocCode>
      </DocSection>
      <DocSection title="Revoke / rotate">
        <DocCode>{`POST /v1/developer/keys/:id/revoke
POST /v1/developer/keys/:id/rotate`}</DocCode>
        <p className="mt-3">Rotating returns a fresh plaintext key (shown once) and immediately invalidates the old one.</p>
      </DocSection>
      <DocSection title="Never expose">
        <DocList items={[
          "The full key is shown exactly once at creation/rotation.",
          "Only a one-way hash is stored server-side.",
          "Never send keys in URLs or logs."
        ]} />
      </DocSection>
    </div>
  );
}
