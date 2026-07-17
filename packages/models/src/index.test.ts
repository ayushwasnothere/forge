import { describe, expect, it } from "vitest";
import { calculateCost, getModelPricing } from "./index";

describe("Pricing and Cost calculations", () => {
  it("resolves default prices for common models", () => {
    const sonnet = getModelPricing("anthropic/claude-3-5-sonnet");
    expect(sonnet.inputPerMillion).toBe(3.0);
    expect(sonnet.outputPerMillion).toBe(15.0);

    const mini = getModelPricing("openai/gpt-4o-mini");
    expect(mini.inputPerMillion).toBe(0.15);
    expect(mini.outputPerMillion).toBe(0.6);

    const unknown = getModelPricing("unknown-provider/super-smart-model");
    expect(unknown.inputPerMillion).toBe(5.0);
    expect(unknown.outputPerMillion).toBe(15.0);

    const freeModel = getModelPricing("ollama/free-model");
    expect(freeModel.inputPerMillion).toBe(0.0);
    expect(freeModel.outputPerMillion).toBe(0.0);
  });

  it("resolves pricing overrides", () => {
    const custom = {
      "custom-model": { inputPerMillion: 1.25, outputPerMillion: 3.75 },
    };
    const resolved = getModelPricing("provider/my-custom-model-v2", custom);
    expect(resolved.inputPerMillion).toBe(1.25);
    expect(resolved.outputPerMillion).toBe(3.75);
  });

  it("calculates cost accurately", () => {
    const pricing = { inputPerMillion: 2.0, outputPerMillion: 10.0 };
    const cost = calculateCost(500_000, 100_000, pricing);
    // (500,000 / 1,000,000) * 2.0 + (100,000 / 1,000,000) * 10.0 = 1.0 + 1.0 = 2.0
    expect(cost).toBe(2.0);
  });
});
