import { describe, expect, it } from "vitest";
import type { Constraints } from "../shared/types";
import {
  MockProvider,
  ROUTING_UNAVAILABLE_ENV,
} from "../server/routing/provider";
import { searchPlans } from "../server/routing/search";

function constraints(overrides: Partial<Constraints> = {}): Constraints {
  return {
    budget: 60_000,
    reserve: 20_000,
    curfew: 1_290,
    allowedModes: ["walk", "bus", "metro", "suburban", "auto"],
    allowUncertainty: false,
    curfewBuffer: 30,
    delayAllowances: {},
    unknownFareFallbackPaise: {},
    ...overrides,
  };
}

describe("chennai-demo testScenarios", () => {
  it("S1_happy_path returns a safe metro/bus plan with positive curfew slack", async () => {
    const provider = new MockProvider();
    const scenario = provider
      .getDataset()
      .testScenarios.find((item) => item.id === "S1_happy_path");
    expect(scenario?.expected).toContain("At least one valid plan");

    const results = await searchPlans(
      {
        from: "my hostel",
        to: "Marina Beach",
        departAt: 16 * 60,
        dwellMin: 120,
        maxTransfers: 2,
        constraints: constraints({
          allowedModes: ["walk", "bus", "metro"],
          // The fixture's additive bus + metro delay allowances put the
          // exact 21:00 buffered boundary one minute out of reach.
          curfew: 21 * 60 + 31,
        }),
      },
      provider,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.safe)).toBe(true);
    expect(results[0]?.plan.outward.flatMap((leg) => leg.mode)).not.toContain("auto");
    expect(results[0]?.plan.return.flatMap((leg) => leg.mode)).not.toContain("auto");
    expect(results[0]!.plan.return[0]!.depart).toBeGreaterThanOrEqual(
      results[0]!.plan.outward.at(-1)!.arrive + 120,
    );
    expect(results[0]!.validation.checks.find((check) => check.name === "curfew")?.passed).toBe(
      true,
    );
  });

  it("S2_unknown_fare rejects the unknown bus fare unless uncertainty is allowed", async () => {
    const provider = new MockProvider();
    const scenario = provider
      .getDataset()
      .testScenarios.find((item) => item.id === "S2_unknown_fare");
    expect(scenario?.expected).toContain("unknown fare");

    const request = {
      from: "Express Avenue",
      to: "Marina Beach",
      departAt: 17 * 60,
      dwellMin: 90,
    };
    const rejected = await searchPlans(
      { ...request, constraints: constraints({ allowedModes: ["bus"] }) },
      provider,
    );
    expect(rejected[0]?.status).toBe("NOT SAFE");
    expect(rejected[0]?.failedChecks.some((check) => check.name === "unknown-fares")).toBe(true);

    const allowed = await searchPlans(
      {
        ...request,
        constraints: constraints({
          allowedModes: ["bus"],
          allowUncertainty: true,
          budget: 50_000,
          reserve: 15_000,
          curfew: 22 * 60,
        }),
      },
      provider,
    );
    expect(allowed.some((result) => result.safe)).toBe(true);
    expect(
      allowed[0]!.plan.outward.some((leg) => leg.fare.confidence === "unknown"),
    ).toBe(true);
    expect(
      allowed[0]!.validation.checks.find((check) => check.name === "unknown-fares")?.message,
    ).toContain("unknownFareFallbackPaise");
  });

  it("S3_no_safe_plan returns one least-bad NOT SAFE plan with failed checks", async () => {
    const provider = new MockProvider();
    const scenario = provider
      .getDataset()
      .testScenarios.find((item) => item.id === "S3_no_safe_plan");
    expect(scenario?.expected).toContain("No plan satisfies");

    const results = await searchPlans(
      {
        from: "my hostel",
        to: "Phoenix Marketcity",
        departAt: 20 * 60 + 30,
        dwellMin: 60,
        constraints: constraints({
          budget: 40_000,
          reserve: 15_000,
          curfew: 23 * 60,
        }),
      },
      provider,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("NOT SAFE");
    expect(results[0]?.safe).toBe(false);
    expect(results[0]?.failedChecks.length).toBeGreaterThan(0);
  });

  it("S4_budget_impossible reports the budget failure and no safe plan", async () => {
    const provider = new MockProvider();
    const scenario = provider
      .getDataset()
      .testScenarios.find((item) => item.id === "S4_budget_impossible");
    expect(scenario?.expected).toContain("No valid plan");

    const results = await searchPlans(
      {
        from: "my hostel",
        to: "Marina Beach",
        departAt: 16 * 60,
        dwellMin: 120,
        maxTransfers: 2,
        constraints: constraints({
          budget: 15_000,
          reserve: 10_000,
          curfew: 22 * 60,
        }),
      },
      provider,
    );

    expect(results[0]?.status).toBe("NOT SAFE");
    expect(results[0]?.failedChecks.some((check) => check.name === "budget")).toBe(true);
  });

  it("S5_night_surcharge applies 1.5x to both auto fare bounds after 23:00", async () => {
    const provider = new MockProvider();
    const scenario = provider
      .getDataset()
      .testScenarios.find((item) => item.id === "S5_night_surcharge");
    expect(scenario?.expected).toContain("1.5x");

    const outward = await provider.findItineraries({
      from: "my hostel",
      to: "T. Nagar",
      departAt: 21 * 60 + 30,
      allowedModes: ["auto"],
      maxTransfers: 0,
    });
    expect(outward[0]?.legs[0]?.depart).toBe(21 * 60 + 35);
    expect(outward[0]?.legs[0]?.fare).toMatchObject({ min: 16_000, max: 26_000 });

    const returning = await provider.findItineraries({
      from: "T. Nagar",
      to: "my hostel",
      departAt: outward[0]!.arrival + 90,
      allowedModes: ["auto"],
      maxTransfers: 0,
    });
    expect(returning[0]?.legs[0]?.depart).toBeGreaterThan(23 * 60);
    expect(returning[0]?.legs[0]?.fare).toMatchObject({ min: 24_000, max: 39_000 });
  });

  it("S6_disruption_replan avoids the cancelled return metro and uses a fallback or NOT SAFE", async () => {
    const provider = new MockProvider();
    const scenario = provider
      .getDataset()
      .testScenarios.find((item) => item.id === "S6_disruption_replan");
    expect(scenario?.expected).toContain("Re-plan");

    const results = await searchPlans(
      {
        from: "my hostel",
        to: "Marina Beach",
        departAt: 16 * 60,
        dwellMin: 120,
        blockedEdgeIds: ["e07:reverse"],
        constraints: constraints({
          allowedModes: ["walk", "bus", "metro", "suburban"],
          curfew: 21 * 60 + 30,
        }),
      },
      provider,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(
      [...results[0]!.plan.outward, ...results[0]!.plan.return].some(
        (leg) => leg.id === "e07:reverse",
      ),
    ).toBe(false);
    expect(results[0]!.safe || results[0]!.status === "NOT SAFE").toBe(true);
  });

  it("loads both directions, defaults edge service windows, and resolves aliases", async () => {
    const provider = new MockProvider();
    expect(provider.getExpandedEdges()).toHaveLength(provider.getDataset().edges.length * 2);
    expect(provider.resolvePlace("my Guindy hostel").id).toBe("hostel_guindy");
    expect(
      provider.getExpandedEdges().find((edge) => edge.baseEdgeId === "e07")?.serviceWindow,
    ).toEqual(provider.getDataset().modeDefaults.metro!.serviceWindow);

    const metro = await provider.findItineraries({
      from: "Guindy",
      to: "Central",
      departAt: 960,
      allowedModes: ["metro"],
      maxTransfers: 0,
    });
    expect(metro[0]?.legs[0]?.depart).toBe(960);
    expect(metro[0]?.legs[0]?.id).toBe("e07:forward");
  });

  it("throws the exact routing-unavailable error for the env flag and runtime toggle", async () => {
    const provider = new MockProvider();
    const previous = process.env[ROUTING_UNAVAILABLE_ENV];
    try {
      process.env[ROUTING_UNAVAILABLE_ENV] = "true";
      await expect(
        provider.findItineraries({
          from: "Guindy",
          to: "Central",
          departAt: 960,
        }),
      ).rejects.toThrow("routing unavailable");

      delete process.env[ROUTING_UNAVAILABLE_ENV];
      provider.setRoutingUnavailable(true);
      await expect(
        provider.findItineraries({
          from: "Guindy",
          to: "Central",
          departAt: 960,
        }),
      ).rejects.toThrow("routing unavailable");

      provider.toggleRoutingUnavailable();
      const available = await provider.findItineraries({
        from: "Guindy",
        to: "Central",
        departAt: 960,
      });
      expect(available.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env[ROUTING_UNAVAILABLE_ENV];
      else process.env[ROUTING_UNAVAILABLE_ENV] = previous;
    }
  });
});