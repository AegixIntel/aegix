import { DocHeading, DocSection, DocList } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sessions" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Security" title="Sessions" lead="How AEGIX keeps your session secure." />
      <DocSection title="Session token">
        <DocList items={[
          "A session token is stored locally and sent as a bearer token.",
          "The server validates it on every request.",
          "Switching wallets invalidates the prior session.",
          "Challenges are domain-bound, nonce-based, and time-limited to prevent replay."
        ]} />
      </DocSection>
    </div>
  );
}
