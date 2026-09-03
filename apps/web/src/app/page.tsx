import { PublicNavbar } from "@/components/layout/public-navbar";
import { PublicFooter } from "@/components/layout/public-footer";
import {
  HeroSection,
  IntroductionSection,
  LiveIntelligenceSection,
  PrimitivesSection,
  PipelineSection,
  EpistemicSection,
  CompareSection,
  MonitoringSection,
  DeveloperSection,
  MarketSection,
  HowSection,
  NetworkSection,
  RoadmapTeaserSection,
  FinalCtaSection
} from "@/components/layout/landing-sections";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-ink-deep">
      <PublicNavbar />
      <main className="flex-1">
        <HeroSection />
        <IntroductionSection />
        <LiveIntelligenceSection />
        <PrimitivesSection />
        <PipelineSection />
        <EpistemicSection />
        <CompareSection />
        <MonitoringSection />
        <DeveloperSection />
        <MarketSection />
        <HowSection />
        <NetworkSection />
        <RoadmapTeaserSection />
        <FinalCtaSection />
      </main>
      <PublicFooter />
    </div>
  );
}
