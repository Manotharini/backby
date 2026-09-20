import { describe, expect, it } from "vitest";
import type { Constraints, FareConfidence, Leg, Plan } from "../shared/types";
import { addPaise, fareEstimate, formatPaise, planWorstCaseCost } from "../server/engine/money";
import { delayedArrival, withinServiceWindow } from "../server/engine/time";
import { riskScore } from "../server/engine/risk";
import { validatePlan } from "../server/engine/validate";

const baseConstraints: Constraints = {
  budget: 2_000,
  reserve: 500,
  curfew: 1_300,
  allowedModes: ["metro", "bus", "walk"],
  allowUncertainty: false,
  fallbackReturnCost: 300,
  curfewBuffer: 30,
  delayAllowances: { metro: 10, bus: 15, walk: 0 },
  unknownFareFallbackPaise: { metro: 175, bus: 3_000 },
};

function leg(
  id: string,
  from: string,
  to: string,
  depart: number,
  arrive: number,
  fare = 100,
  mode = "metro",
  confidence: FareConfidence = "confirmed",
): Leg {
  return {
    id,
    mode,
    from,
    to,
    depart,
    arrive,
    fare:
      confidence === "unknown"
        ? { min: null, max: null, confidence }
        : { min: fare, max: fare, confidence },
    serviceWindow: { first: depart - 20, last: depart + 20 },
  };
}

function validPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    outward: [leg("out-1", "hostel", "station", 100, 120)],
    dwell: 60,
    return: [leg("back-1", "station", "hostel", 200, 230)],
    ...overrides,
  };
}

function check(plan: Plan, constraints = baseConstraints, name: string) {
  return validatePlan(plan, constraints).checks.find((item) => item.name === name);
}

describe("money", () => {
  it("adds integer paise without floating-point currency conversion", () => {
    expect(addPaise(101, 202, 303)).toBe(606);
  });

  it("uses fare.max as the conservative estimate", () => {
    expect(fareEstimate({ min: 100, max: 135, confidence: "estimated" })).toBe(135);
  });

  it("sums worst-case fares across a plan", () => {
    expect(planWorstCaseCost([leg("a", "x", "y", 1, 2, 125), leg("b", "y", "z", 3, 4, 225)])).toBe(350);
  });

  it("formats paise only at the display boundary", () => {
    expect(formatPaise(12345)).toBe("₹123.45");
  });
});

describe("time", () => {
  it("treats service-window endpoints as inclusive", () => {
    expect(withinServiceWindow(100, 100, 120)).toBe(true);
    expect(withinServiceWindow(120, 100, 120)).toBe(true);
  });

  it("rejects a departure outside its service window", () => {
    expect(withinServiceWindow(121, 100, 120)).toBe(false);
  });

  it("adds delay allowances in epoch minutes", () => {
    expect(delayedArrival(leg("x", "a", "b", 10, 20), 15)).toBe(35);
  });
});

describe("validatePlan continuity and eligibility", () => {
  it("accepts a connected plan at the exact dwell boundary", () => {
    expect(check(validPlan(), baseConstraints, "continuity")?.passed).toBe(true);
  });

  it("rejects disconnected legs", () => {
    const plan = validPlan({
      return: [leg("back-1", "airport", "hostel", 200, 230)],
    });
    expect(check(plan, baseConstraints, "continuity")?.passed).toBe(false);
  });

  it("rejects a return leg before the dwell boundary", () => {
    const plan = validPlan({
      return: [leg("back-1", "station", "hostel", 179, 230)],
    });
    expect(check(plan, baseConstraints, "continuity")?.passed).toBe(false);
  });

  it("rejects an overlap between consecutive legs", () => {
    const plan = validPlan({
      outward: [
        leg("out-1", "hostel", "station", 100, 150),
        leg("out-2", "station", "venue", 140, 170),
      ],
    });
    expect(check(plan, baseConstraints, "continuity")?.passed).toBe(false);
  });

  it("allows a connection with no transfer gap", () => {
    const plan = validPlan({
      outward: [
        leg("out-1", "hostel", "station", 100, 120),
        leg("out-2", "station", "venue", 120, 150),
      ],
      return: [leg("back-1", "venue", "hostel", 210, 240)],
    });
    expect(check(plan, baseConstraints, "continuity")?.passed).toBe(true);
  });

  it("accepts an allowed mode and departure at the first service minute", () => {
    const plan = validPlan({
      outward: [leg("out-1", "hostel", "station", 100, 120, 100, "bus")],
    });
    expect(check(plan, baseConstraints, "eligibility")?.passed).toBe(true);
  });

  it("rejects a mode outside user preferences", () => {
    const plan = validPlan({
      outward: [leg("out-1", "hostel", "station", 100, 120, 100, "taxi")],
    });
    expect(check(plan, baseConstraints, "eligibility")?.passed).toBe(false);
  });

  it("rejects departure after the last service minute", () => {
    const plan = validPlan({
      outward: [
        {
          ...leg("out-1", "hostel", "station", 100, 120),
          depart: 121,
          serviceWindow: { first: 80, last: 120 },
        },
      ],
    });
    expect(check(plan, baseConstraints, "eligibility")?.passed).toBe(false);
  });

  it("can read allowed modes from preferences", () => {
    const { allowedModes: _allowedModes, ...withoutTopLevelModes } = baseConstraints;
    const constraints = {
      ...withoutTopLevelModes,
      preferences: { allowedModes: ["metro"] },
    };
    expect(check(validPlan(), constraints, "eligibility")?.passed).toBe(true);
  });
});

describe("validatePlan money and fares", () => {
  it("passes budget exactly at budget minus reserve", () => {
    const plan = validPlan({
      outward: [leg("out-1", "hostel", "station", 100, 120, 750)],
      return: [leg("back-1", "station", "hostel", 200, 230, 750)],
    });
    expect(check(plan, baseConstraints, "budget")?.passed).toBe(true);
  });

  it("rejects budget one paise over budget minus reserve", () => {
    const plan = validPlan({
      outward: [leg("out-1", "hostel", "station", 100, 120, 751)],
      return: [leg("back-1", "station", "hostel", 200, 230, 750)],
    });
    expect(check(plan, baseConstraints, "budget")?.passed).toBe(false);
  });

  it("uses fare.max for worst-case budget", () => {
    const plan = validPlan({
      outward: [
        {
          ...leg("out-1", "hostel", "station", 100, 120, 100, "metro", "estimated"),
          fare: { min: 100, max: 1_501, confidence: "estimated" },
        },
      ],
    });
    expect(check(plan, baseConstraints, "budget")?.passed).toBe(false);
  });

  it("passes reserve when remaining money and reserve equal their limits", () => {
    const plan = validPlan({
      outward: [leg("out-1", "hostel", "station", 100, 120, 500)],
      return: [leg("back-1", "station", "hostel", 200, 230, 1_000)],
    });
    expect(check(plan, baseConstraints, "reserve")?.passed).toBe(true);
  });

  it("rejects when remaining budget is one paise below reserve", () => {
    const plan = validPlan({
      outward: [leg("out-1", "hostel", "station", 100, 120, 501)],
      return: [leg("back-1", "station", "hostel", 200, 230, 1_000)],
    });
    expect(check(plan, baseConstraints, "reserve")?.passed).toBe(false);
  });

  it("rejects when reserve is below the cheapest fallback return cost", () => {
    const constraints = { ...baseConstraints, fallbackReturnCost: 501 };
    expect(check(validPlan(), constraints, "reserve")?.passed).toBe(false);
  });

  it("rejects a reserve check without a fallback cost", () => {
    const { fallbackReturnCost: _fallbackReturnCost, ...constraints } = baseConstraints;
    expect(check(validPlan(), constraints, "reserve")?.passed).toBe(false);
  });

  it("rejects unknown fares by default", () => {
    const plan = validPlan({
      outward: [leg("out-1", "hostel", "station", 100, 120, 100, "metro", "unknown")],
    });
    expect(check(plan, baseConstraints, "unknown-fares")?.passed).toBe(false);
  });

  it("allows unknown fares when uncertainty is explicitly allowed", () => {
    const plan = validPlan({
      outward: [leg("out-1", "hostel", "station", 100, 120, 100, "metro", "unknown")],
    });
    expect(
      check(plan, { ...baseConstraints, allowUncertainty: true }, "unknown-fares")?.passed,
    ).toBe(true);
  });

  it("flags unknown fares while retaining the conservative max estimate", () => {
    const plan = validPlan({
      outward: [
        {
          ...leg("out-1", "hostel", "station", 100, 120, 100, "metro", "unknown"),
          fare: { min: null, max: null, confidence: "unknown" },
        },
      ],
    });
    const result = check(plan, { ...baseConstraints, allowUncertainty: true }, "unknown-fares");
    expect(result?.message).toContain("unknownFareFallbackPaise");
    expect(result?.actual).toMatchObject({ conservativeEstimate: 275 });
  });
});

describe("validatePlan curfew and combined result", () => {
  it("passes arrival exactly at curfew minus the default 30-minute buffer", () => {
    const plan = validPlan({
      return: [leg("back-1", "station", "hostel", 200, 1_270)],
    });
    const constraints = { ...baseConstraints, delayAllowances: { metro: 0 } };
    expect(check(plan, constraints, "curfew")?.passed).toBe(true);
  });

  it("rejects arrival one minute after the buffered curfew", () => {
    const plan = validPlan({
      return: [leg("back-1", "station", "hostel", 200, 1_271)],
    });
    const constraints = { ...baseConstraints, delayAllowances: { metro: 0 } };
    expect(check(plan, constraints, "curfew")?.passed).toBe(false);
  });

  it("applies every return-leg delay allowance to worst-case arrival", () => {
    const plan = validPlan({
      return: [
        leg("back-1", "station", "junction", 200, 220, 100, "bus"),
        leg("back-2", "junction", "hostel", 220, 250, 100, "metro"),
      ],
    });
    const constraints = {
      ...baseConstraints,
      delayAllowances: { bus: 20, metro: 10 },
    };
    expect(check(plan, constraints, "curfew")?.actual).toBe(280);
    expect(check(plan, constraints, "curfew")?.passed).toBe(true);
  });

  it("uses a custom curfew buffer", () => {
    const plan = validPlan({
      return: [leg("back-1", "station", "hostel", 200, 1_250)],
    });
    const constraints = {
      ...baseConstraints,
      curfewBuffer: 60,
      delayAllowances: { metro: 0 },
    };
    expect(check(plan, constraints, "curfew")?.passed).toBe(false);
  });

  it("requires a return leg to pass curfew", () => {
    const plan = validPlan({ return: [] });
    expect(check(plan, baseConstraints, "curfew")?.passed).toBe(false);
  });

  it("returns valid only when every check passes", () => {
    expect(validatePlan(validPlan(), baseConstraints).valid).toBe(true);
    const invalid = validPlan({
      outward: [leg("out-1", "hostel", "station", 100, 120, 100, "taxi")],
    });
    expect(validatePlan(invalid, baseConstraints).valid).toBe(false);
  });
});

describe("riskScore", () => {
  it("is deterministic for the same plan and constraints", () => {
    const first = riskScore(validPlan(), baseConstraints);
    expect(riskScore(validPlan(), baseConstraints)).toBe(first);
  });

  it("stays within the documented 0-100 range", () => {
    const risky = validPlan({
      outward: [
        leg("out-1", "hostel", "a", 100, 120, 1_000, "metro", "unknown"),
        leg("out-2", "a", "station", 120, 140, 1_000, "bus", "estimated"),
      ],
      return: [
        leg("back-1", "station", "b", 200, 1_200, 100, "bus"),
        leg("back-2", "b", "hostel", 1_200, 1_290, 100, "metro"),
      ],
    });
    expect(riskScore(risky, baseConstraints)).toBeGreaterThanOrEqual(0);
    expect(riskScore(risky, baseConstraints)).toBeLessThanOrEqual(100);
  });

  it("increases when curfew slack gets worse", () => {
    const safe = riskScore(validPlan(), baseConstraints);
    const late = riskScore(
      validPlan({ return: [leg("back-1", "station", "hostel", 200, 1_269)] }),
      { ...baseConstraints, delayAllowances: { metro: 0 } },
    );
    expect(late).toBeGreaterThan(safe);
  });

  it("increases for transfers and uncertain fares", () => {
    const simple = riskScore(validPlan(), baseConstraints);
    const complex = riskScore(
      validPlan({
        outward: [
          leg("out-1", "hostel", "a", 100, 120),
          leg("out-2", "a", "station", 120, 140, 100, "bus", "unknown"),
        ],
        return: [
          leg("back-1", "station", "b", 200, 220, 100, "bus"),
          leg("back-2", "b", "hostel", 220, 250, 100, "metro"),
        ],
      }),
      baseConstraints,
    );
    expect(complex).toBeGreaterThan(simple);
  });

  it("treats an exhausted spend limit as maximum budget risk", () => {
    const score = riskScore(validPlan(), { ...baseConstraints, budget: 500, reserve: 500 });
    expect(score).toBeGreaterThanOrEqual(25);
  });
});