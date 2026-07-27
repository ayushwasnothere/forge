import { FeatureGrid } from "./FeatureGrid";
import { Hero } from "./Hero";
import { ProvidersRow } from "./ProvidersRow";
import { Quickstart } from "./Quickstart";
import { TerminalDemo } from "./TerminalDemo";

export function Landing() {
  return (
    <>
      <Hero />
      <TerminalDemo />
      <ProvidersRow />
      <FeatureGrid />
      <Quickstart />
    </>
  );
}
