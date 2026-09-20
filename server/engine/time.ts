import type { Leg, Plan } from "../../shared/types";

export function assertEpochMinute(value: number, label = "time"): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer epoch minute`);
  }
  return value;
}

export function withinServiceWindow(depart: number, first: number, last: number): boolean {
  assertEpochMinute(depart, "depart");
  assertEpochMinute(first, "serviceWindow.first");
  assertEpochMinute(last, "serviceWindow.last");
  return first <= last && depart >= first && depart <= last;
}

export function delayedArrival(
  leg: Leg,
  delayAllowance: number,
): number {
  assertEpochMinute(leg.arrive, "leg.arrive");
  assertEpochMinute(delayAllowance, "delayAllowance");
  return leg.arrive + delayAllowance;
}

export function worstCaseArrival(
  legs: readonly Leg[],
  delayAllowances: Readonly<Record<string, number>>,
): number | undefined {
  const last = legs.at(-1);
  if (!last) return undefined;

  const delay = legs.reduce((total, leg) => {
    const allowance = delayAllowances[leg.mode] ?? 0;
    assertEpochMinute(allowance, `delayAllowances.${leg.mode}`);
    return total + allowance;
  }, 0);
  return delayedArrival(last, delay);
}

export function lastServiceMargin(legs: readonly Leg[]): number | undefined {
  if (legs.length === 0) return undefined;
  return Math.min(...legs.map((leg) => leg.serviceWindow.last - leg.depart));
}

export function planLegs(plan: Plan): Leg[] {
  return [...plan.outward, ...plan.return];
}

export function transferCount(plan: Plan): number {
  const outwardTransfers = Math.max(0, plan.outward.length - 1);
  const returnTransfers = Math.max(0, plan.return.length - 1);
  return outwardTransfers + returnTransfers;
}