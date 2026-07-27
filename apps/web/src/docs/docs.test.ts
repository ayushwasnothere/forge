import { describe, expect, it } from "vitest";
import { docs, getDoc } from "./docs";

describe("docs manifest", () => {
  it("has at least one page", () => {
    expect(docs.length).toBeGreaterThan(0);
  });
  it("has unique slugs and a title + component per entry", () => {
    const slugs = new Set<string>();
    for (const d of docs) {
      expect(d.slug).toMatch(/^[a-z0-9-]+$/);
      expect(slugs.has(d.slug)).toBe(false);
      slugs.add(d.slug);
      expect(d.title.length).toBeGreaterThan(0);
      expect(typeof d.Component).toBe("function");
    }
  });
  it("getDoc resolves known slugs and rejects unknown ones", () => {
    expect(getDoc("getting-started")?.title).toBe("Getting Started");
    expect(getDoc("nope")).toBeUndefined();
  });
});
