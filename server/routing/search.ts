import type {
  Constraints,
  Plan,
  PlanCheck,
  ValidationResult,
} from "../../shared/types";
import { planWorstCaseCost } from "../engine/money";
import { riskScore } from "../engine/risk";
import { validatePlan } from "../engine/validate";
import type {
  Itinerary,
  RoutingProvider,
} from "./provider";
import { constraintsWithProviderDefaults } from "./provider";

export interface SearchRequest {
  from: string;
  to: string;
  departAt: number;
  dwellMin: number;
  constraints: Constraints;
  maxTransfers?: number;
  blockedEdgeIds?: readonly string[];
}

export interface SearchResult {
  status: "SAFE" | "NOT SAFE";
  safe: boolean;
  plan: Plan;
  validation: ValidationResult;
  failedChecks: PlanCheck[];
  risk: number;
}

function allowedModes(constraints: Constraints): readonly string[] | undefined {
  return constraints.allowedModes ?? constraints.preferences?.allowedModes;
}

function invalidPlanResult(
  plan: Plan,
  validation: ValidationResult,
  constraints: Constraints,
): SearchResult {
  return {
    status: "NOT SAFE",
    safe: false,
    plan,
    validation,
    failedChecks: validation.checks.filter((check) => !check.passed),
    risk: riskScore(plan, constraints),
  };
}

function compareLeastBad(left: SearchResult, right: SearchResult): number {
  return (
    left.failedChecks.length - right.failedChecks.length ||
    left.risk - right.risk ||
    (left.plan.return.at(-1)?.arrive ?? Number.MAX_SAFE_INTEGER) -
      (right.plan.return.at(-1)?.arrive ?? Number.MAX_SAFE_INTEGER)
  );
}

function compareSafe(left: SearchResult, right: SearchResult): number {
  return (
    left.risk - right.risk ||
    (left.plan.return.at(-1)?.arrive ?? Number.MAX_SAFE_INTEGER) -
      (right.plan.return.at(-1)?.arrive ?? Number.MAX_SAFE_INTEGER)
  );
}

function withFallbackCost(
  constraints: Constraints,
  returnItineraries: readonly Itinerary[],
): Constraints {
  if (constraints.fallbackReturnCost !== undefined) return constraints;
  const fallbackReturnCost = returnItineraries
    .map((itinerary) =>
      planWorstCaseCost(
        itinerary.legs,
        constraints.unknownFareFallbackPaise ?? {},
      ),
    )
    .sort((left, right) => left - right)[0];
  return { ...constraints, fallbackReturnCost };
}

/**
 * Finds outward and return legs independently. A return search starts at
 * outward arrival + dwellMin, so scheduled return departures are calculated
 * from the actual outing rather than from a fixed clock time.
 */
export async function searchPlans(
  request: SearchRequest,
  provider: RoutingProvider,
): Promise<SearchResult[]> {
  if (!Number.isSafeInteger(request.dwellMin) || request.dwellMin < 0) {
    throw new RangeError("dwellMin must be a non-negative integer epoch-minute duration");
  }

  const baseConstraints = constraintsWithProviderDefaults(
    request.constraints,
    provider,
  );
  const outwardItineraries = await provider.findItineraries({
    from: request.from,
    to: request.to,
    departAt: request.departAt,
    allowedModes: allowedModes(baseConstraints),
    maxTransfers: request.maxTransfers ?? 3,
    blockedEdgeIds: request.blockedEdgeIds,
  });

  const safeResults: SearchResult[] = [];
  const unsafeResults: SearchResult[] = [];

  for (const outward of outwardItineraries) {
    const returnItineraries = await provider.findItineraries({
      from: request.to,
      to: request.from,
      departAt: outward.arrival + request.dwellMin,
      allowedModes: allowedModes(baseConstraints),
      maxTransfers: request.maxTransfers ?? 3,
      blockedEdgeIds: request.blockedEdgeIds,
    });
    const constraints = withFallbackCost(baseConstraints, returnItineraries);

    if (returnItineraries.length === 0) {
      const plan: Plan = {
        outward: outward.legs,
        dwell: request.dwellMin,
        return: [],
      };
      unsafeResults.push(
        invalidPlanResult(plan, validatePlan(plan, constraints), constraints),
      );
      continue;
    }

    for (const returning of returnItineraries) {
      const plan: Plan = {
        outward: outward.legs,
        dwell: request.dwellMin,
        return: returning.legs,
      };
      const validation = validatePlan(plan, constraints);
      const result = validation.valid
        ? {
            status: "SAFE" as const,
            safe: true,
            plan,
            validation,
            failedChecks: [],
            risk: riskScore(plan, constraints),
          }
        : invalidPlanResult(plan, validation, constraints);
      if (result.safe) safeResults.push(result);
      else unsafeResults.push(result);
    }
  }

  if (safeResults.length > 0) {
    return safeResults.sort(compareSafe);
  }

  if (unsafeResults.length > 0) {
    return [unsafeResults.sort(compareLeastBad)[0]!];
  }

  const emptyPlan: Plan = {
    outward: [],
    dwell: request.dwellMin,
    return: [],
  };
  const validation = validatePlan(emptyPlan, baseConstraints);
  return [invalidPlanResult(emptyPlan, validation, baseConstraints)];
}

export class SearchModule {
  constructor(private readonly provider: RoutingProvider) {}

  search(request: SearchRequest): Promise<SearchResult[]> {
    return searchPlans(request, this.provider);
  }
}