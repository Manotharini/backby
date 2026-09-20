import type {
  Constraints,
  Leg,
  Plan,
  PlanCheck,
  ValidationResult,
} from "../../shared/types";
import { fareEstimate, planWorstCaseCost } from "./money";
import {
  planLegs,
  withinServiceWindow,
  worstCaseArrival,
} from "./time";

function allowedModes(constraints: Constraints): readonly string[] {
  return constraints.allowedModes ?? constraints.preferences?.allowedModes ?? [];
}

function buffer(constraints: Constraints): number {
  return constraints.curfewBuffer ?? 30;
}

function unknownFareFallbacks(
  constraints: Constraints,
): Readonly<Record<string, number>> {
  return constraints.unknownFareFallbackPaise ?? {};
}

function allPairsConnect(legs: readonly Leg[]): string[] {
  const issues: string[] = [];
  for (let index = 1; index < legs.length; index += 1) {
    const previous = legs[index - 1];
    const current = legs[index];
    if (!previous || !current) continue;
    if (previous.to !== current.from) {
      issues.push(`${previous.id}->${current.id}: places do not connect`);
    }
    if (previous.arrive > current.depart) {
      issues.push(`${previous.id}->${current.id}: time order is invalid`);
    }
  }
  return issues;
}

function continuityCheck(plan: Plan): PlanCheck {
  const issues = [
    ...allPairsConnect(plan.outward),
    ...allPairsConnect(plan.return),
  ];

  const outwardLast = plan.outward.at(-1);
  const returnFirst = plan.return[0];
  if (!outwardLast || !returnFirst) {
    issues.push("both outward and return journeys are required");
  } else {
    if (outwardLast.to !== returnFirst.from) {
      issues.push("destination does not connect to the first return leg");
    }
    if (outwardLast.arrive + plan.dwell > returnFirst.depart) {
      issues.push("return departs before the required destination dwell");
    }
  }

  return {
    name: "continuity",
    passed: issues.length === 0,
    actual: { issues },
    limit: "connected places, non-decreasing times, and required dwell",
    message:
      issues.length === 0
        ? "Every leg connects in place and time order, including destination dwell."
        : issues.join("; "),
  };
}

function eligibilityCheck(plan: Plan, constraints: Constraints): PlanCheck {
  const modes = allowedModes(constraints);
  const legs = planLegs(plan);
  const invalidModes = legs
    .filter((leg) => !modes.includes(leg.mode))
    .map((leg) => `${leg.id}:${leg.mode}`);
  const outsideWindows = legs
    .filter(
      (leg) =>
        !withinServiceWindow(
          leg.depart,
          leg.serviceWindow.first,
          leg.serviceWindow.last,
        ),
    )
    .map((leg) => leg.id);
  const passed = invalidModes.length === 0 && outsideWindows.length === 0;

  return {
    name: "eligibility",
    passed,
    actual: { invalidModes, outsideWindows },
    limit: {
      allowedModes: modes,
      serviceWindow: "first <= depart <= last",
    },
    message: passed
      ? "All modes are allowed and every leg departs during service."
      : [
          invalidModes.length > 0
            ? `disallowed modes: ${invalidModes.join(", ")}`
            : "",
          outsideWindows.length > 0
            ? `outside service window: ${outsideWindows.join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("; "),
  };
}

function budgetCheck(plan: Plan, constraints: Constraints): PlanCheck {
  const spend = planWorstCaseCost(planLegs(plan), unknownFareFallbacks(constraints));
  const limit = constraints.budget - constraints.reserve;
  return {
    name: "budget",
    passed: spend <= limit,
    actual: spend,
    limit,
    message:
      spend <= limit
        ? `Worst-case spend is ${spend} paise, within the spend limit.`
        : `Worst-case spend is ${spend} paise, above the spend limit of ${limit} paise.`,
  };
}

function reserveCheck(plan: Plan, constraints: Constraints): PlanCheck {
  const spend = planWorstCaseCost(planLegs(plan), unknownFareFallbacks(constraints));
  const remaining = constraints.budget - spend;
  const fallback = constraints.fallbackReturnCost;
  const meetsReserve = remaining >= constraints.reserve;
  const meetsFallback = fallback !== undefined && constraints.reserve >= fallback;
  const passed = meetsReserve && meetsFallback;
  const reasons = [
    !meetsReserve
      ? `remaining budget ${remaining} is below reserve ${constraints.reserve}`
      : "",
    fallback === undefined
      ? "cheapest fallback return cost was not supplied"
      : !meetsFallback
        ? `reserve ${constraints.reserve} is below fallback return cost ${fallback}`
        : "",
  ].filter(Boolean);

  return {
    name: "reserve",
    passed,
    actual: { remaining, fallbackReturnCost: fallback },
    limit: {
      reserve: constraints.reserve,
      fallbackReturnCost: fallback,
    },
    message:
      reasons.length === 0
        ? "Remaining budget covers the reserve and the cheapest fallback return."
        : reasons.join("; "),
  };
}

function curfewCheck(plan: Plan, constraints: Constraints): PlanCheck {
  const arrival = worstCaseArrival(plan.return, constraints.delayAllowances ?? {});
  const limit = constraints.curfew - buffer(constraints);
  const passed = arrival !== undefined && arrival <= limit;
  return {
    name: "curfew",
    passed,
    actual: arrival,
    limit,
    message:
      arrival === undefined
        ? "A return journey is required to evaluate hostel arrival."
        : passed
          ? `Worst-case hostel arrival is ${arrival}, before the curfew limit ${limit}.`
          : `Worst-case hostel arrival is ${arrival}, after the curfew limit ${limit}.`,
  };
}

function unknownFaresCheck(plan: Plan, constraints: Constraints): PlanCheck {
  const unknownFares = planLegs(plan)
    .filter((leg) => leg.fare.confidence === "unknown")
    .map((leg) => leg.id);
  const passed = unknownFares.length === 0 || constraints.allowUncertainty;
  return {
    name: "unknown-fares",
    passed,
    actual: {
      unknownFares,
      conservativeEstimate: planWorstCaseCost(
        planLegs(plan),
        unknownFareFallbacks(constraints),
      ),
    },
    limit: { allowUncertainty: constraints.allowUncertainty },
    message:
      unknownFares.length === 0
        ? "No fares have unknown confidence."
        : passed
          ? `Unknown fares accepted; unknownFareFallbackPaise[mode] is used conservatively for ${unknownFares.join(", ")}.`
          : `Unknown fares are not allowed: ${unknownFares.join(", ")}.`,
  };
}

export function validatePlan(
  plan: Plan,
  constraints: Constraints,
): ValidationResult {
  const checks = [
    continuityCheck(plan),
    eligibilityCheck(plan, constraints),
    budgetCheck(plan, constraints),
    reserveCheck(plan, constraints),
    curfewCheck(plan, constraints),
    unknownFaresCheck(plan, constraints),
  ];
  return {
    valid: checks.every((check) => check.passed),
    checks,
  };
}