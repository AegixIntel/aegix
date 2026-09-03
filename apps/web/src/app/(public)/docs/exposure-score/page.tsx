import { DocHeading, DocSection, DocList } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy Exposure Score" };

export default function ExposureScoreDocPage() {
  return (
    <div>
      <DocHeading eyebrow="Product" title="Privacy Exposure Score" lead="A composite measure of observable linkability, not an identity score." />

      <DocSection title="What it measures">
        <p>The privacy exposure score aggregates how much of a wallet's public on-chain activity is observable and linkable to other wallets, entities, and behavioral patterns. It does not measure who owns a wallet.</p>
      </DocSection>

      <DocSection title="Scoring philosophy">
        <DocList items={[
          "Deterministic, versioned engines — scores are reproducible from the same data.",
          "Strength and confidence are never conflated.",
          "Population commonality discounts common hubs and entities.",
          "Data-quality limits are surfaced, not hidden.",
          "No single evidence family can dominate a conclusion."
        ]} />
      </DocSection>

      <DocSection title="Important distinction">
        <p>A privacy exposure score is not an identity score, and correlation is not proof of ownership.</p>
      </DocSection>
    </div>
  );
}
