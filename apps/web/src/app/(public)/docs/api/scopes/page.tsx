import { DocHeading, DocSection, DocList } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Scopes" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Developer API" title="Scopes" lead="Fine-grained permissions on each key." />
      <DocSection title="Available scopes">
        <DocList items={[
          "intelligence:read — read wallet & compare intelligence",
          "usage:read — read your usage/quota summary"
        ]} />
      </DocSection>
      <DocSection title="Principle of least privilege">
        <p>Grant only the scopes an integration needs. Scopes are validated at key creation and enforced on every request.</p>
      </DocSection>
    </div>
  );
}
