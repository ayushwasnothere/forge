import { FeatureGrid } from "./FeatureGrid";
import { Hero } from "./Hero";
import { ProvidersRow } from "./ProvidersRow";
import { Quickstart } from "./Quickstart";
import { TerminalDemo } from "./TerminalDemo";
import { VideoShowcase } from "./VideoShowcase";

export function Landing() {
  return (
    <>
      <Hero />
      <TerminalDemo />
      <VideoShowcase />
      <div className="section-divider mx-auto max-w-4xl" />
      <FeatureGrid />
      <div className="section-divider mx-auto max-w-4xl" />
      <ProvidersRow />
      <div className="section-divider mx-auto max-w-4xl" />
      <Quickstart />
    </>
  );
}
