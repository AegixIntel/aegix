import {
  CategoryStrip,
  HeroStatement,
  SystemMap,
  HowItWorks,
  ProductLine,
  DeveloperInfra,
  Epistemic,
  NetworkAndRoadmap,
  FinalCta
} from "@/components/marketing/aeron-sections";

export default function Home() {
  return (
    <div className="bg-ink-deep">
      <CategoryStrip />
      <HeroStatement />
      <SystemMap />
      <HowItWorks />
      <ProductLine />
      <DeveloperInfra />
      <Epistemic />
      <NetworkAndRoadmap />
      <FinalCta />
    </div>
  );
}
