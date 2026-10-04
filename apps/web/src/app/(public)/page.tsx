import {
  CategoryStrip,
  SystemMap,
  HowItWorks,
  ProductLine,
  DeveloperInfra,
  Epistemic,
  NetworkAndRoadmap
} from "@/components/marketing/home-sections";
import {
  HeroStatement,
  Fragmented,
  ConnectSignal,
  Exposure,
  DiscoveryFilm,
  FinalCta
} from "@/components/marketing/plate-sections";

export default function Home() {
  return (
    <div className="bg-paper">
      <CategoryStrip />
      <HeroStatement />
      <Fragmented />
      <ConnectSignal />
      <SystemMap />
      <Exposure />
      <HowItWorks />
      <ProductLine />
      <Epistemic />
      <DiscoveryFilm />
      <DeveloperInfra />
      <NetworkAndRoadmap />
      <FinalCta />
    </div>
  );
}
