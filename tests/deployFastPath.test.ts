import { describe, it, expect } from "vitest";
import { tryFastPathDeployPool } from "../src/llm/client.js";

describe("tryFastPathDeployPool", () => {
  it("deploys deterministically when name and symbol are explicit", () => {
    expect(tryFastPathDeployPool("deploy a smart pool called earnest with symbol esp")).toEqual({
      name: "deploy_smart_pool",
      args: { name: "earnest", symbol: "esp" },
    });
  });

  it("preserves the pool name case and accepts an optional base token", () => {
    expect(tryFastPathDeployPool("create new pool named Alcyoneus with ticker alc using USDC")).toEqual({
      name: "deploy_smart_pool",
      args: { name: "Alcyoneus", symbol: "alc", baseToken: "USDC" },
    });
  });

  it("does not guess when name or symbol is missing", () => {
    expect(tryFastPathDeployPool("deploy a smart pool")).toBeNull();
    expect(tryFastPathDeployPool("deploy a pool called earnest")).toBeNull();
    expect(tryFastPathDeployPool("deploy a pool with symbol ESP")).toBeNull();
  });
});
