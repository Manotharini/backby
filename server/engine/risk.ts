import type { Constraints, Plan } from "../../shared/types";
import { planWorstCaseCost } from "./money";
import {
  lastServiceMargin,
  planLegs,
  transferCount,
  worstCaseArrival,
} from "./time";

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function slackRisk(slack: number | undefined, comfortableSlack: number): number {
  if (slack === undefined || !Number.isFinite(slack)) return 100;
  if (slack <= 0) return 100;
  if (slack >= comfortableSlack) return 0;
  return 100 - Math.floor((slack * 100) / comfortableSlack);
}

/**
 * Scores five deterministic signals:
 * - curfew slack (35%): safe at 60+ minutes, critical at zero
 * - budget slack (25%): spend limit is budget minus reserve
 * - last-service margin (15%): safe at 60+ minutes, critical at zero
 * - transfers (15%): 20 points per transfer
 * - fare uncertainty (10%): 15 per estimated and 40 per unknown fare
 *
 * Integer weights keep the result stable and avoid floating-point money math.
 */
export function riskScore(plan: Plan, constraints: Constraints): number {
  const legs = planLegs(plan);
  const spend = planWorstCaseCost(legs, constraints.unknownFareFallbackPaise ?? {});
  const spendLimit = constraints.budget - constraints.reserve;
  const arrival = worstCaseArrival(plan.return, constraints.delayAllowances ?? {});
  const curfewLimit = constraints.curfew - (constraints.curfewBuffer ?? 30);
  const curfewRisk = slackRisk(
    arrival === undefined ? undefined : curfewLimit - arrival,
    60,
  );
  const budgetRisk =
    spendLimit <= 0 ? 100 : clamp(Math.round((spend * 100) / spendLimit));
  const serviceRisk = slackRisk(lastServiceMargin(legs), 60);
  const transferRisk = clamp(transferCount(plan) * 20);
  const uncertaintyRisk = clamp(
    legs.reduce(
      (risk, leg) =>
        risk +
        (leg.fare.confidence === "unknown"
          ? 40
          : leg.fare.confidence === "estimated"
            ? 15
            : 0),
      0,
    ),
  );

  return Math.round(
    (curfewRisk * 35 +
      budgetRisk * 25 +
      serviceRisk * 15 +
      transferRisk * 15 +
      uncertaintyRisk * 10) /
      100,
  );
}