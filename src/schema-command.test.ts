import { describe, expect, it } from "vitest";
import { capDepth } from "./schema-command.js";

describe("capDepth", () => {
  it("keeps shallow structures intact", () => {
    const input = { a: 1, b: { c: 2 } };
    const { value, truncated } = capDepth(input, 6);
    expect(value).toEqual(input);
    expect(truncated).toBe(false);
  });

  it("truncates objects beyond the max depth", () => {
    const input = { l1: { l2: { l3: { l4: "deep" } } } };
    const { value, truncated } = capDepth(input, 2);
    expect(truncated).toBe(true);
    expect(value).toEqual({ l1: { l2: "[…object — use --full]" } });
  });

  it("truncates arrays beyond the max depth", () => {
    const { value, truncated } = capDepth({ items: [[["deep"]]] }, 2);
    expect(truncated).toBe(true);
    expect(value).toEqual({ items: ["[…array — use --full]"] });
  });

  it("does not truncate empty objects or arrays at the boundary", () => {
    const { truncated } = capDepth({ a: {}, b: [] }, 1);
    expect(truncated).toBe(false);
  });

  it("preserves primitives", () => {
    expect(capDepth("x", 0).value).toBe("x");
    expect(capDepth(42, 0).value).toBe(42);
    expect(capDepth(null, 0).value).toBe(null);
  });
});
