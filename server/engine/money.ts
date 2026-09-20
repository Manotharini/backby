import type { Fare, Leg } from "../../shared/types";

/**
 * All values in this module are integer paise. No conversion to a
 * floating-point currency representation is performed.
 */
export function assertPaise(value: number, label = "amount"): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer number of paise`);
  }
  return value;
}

export function addPaise(...amounts: number[]): number {
  const total = amounts.reduce((sum, amount) => {
    assertPaise(amount);
    const next = sum + amount;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("paise total exceeds the safe integer range");
    }
    return next;
  }, 0);
  return total;
}

export function subtractPaise(amount: number, ...subtrahends: number[]): number {
  assertPaise(amount);
  const result = subtrahends.reduce((remaining, subtrahend) => {
    assertPaise(subtrahend);
    return remaining - subtrahend;
  }, amount);
  return result;
}

export function fareEstimate(
  fare: Fare,
  unknownFallbackPaise = 0,
): number {
  if (fare.confidence === "unknown") {
    if (fare.min !== null || fare.max !== null) {
      throw new RangeError("unknown fares must have null min and max");
    }
    return assertPaise(unknownFallbackPaise, "unknown fare fallback");
  }

  if (fare.min === null || fare.max === null) {
    throw new RangeError("known fares must have integer min and max");
  }
  assertPaise(fare.min, "fare.min");
  assertPaise(fare.max, "fare.max");
  if (fare.max < fare.min) {
    throw new RangeError("fare.max must be greater than or equal to fare.min");
  }

  return fare.max;
}

export function planWorstCaseCost(
  legs: readonly Leg[],
  unknownFareFallbackPaise: Readonly<Record<string, number>> = {},
): number {
  return legs.reduce(
    (total, leg) =>
      addPaise(
        total,
        fareEstimate(leg.fare, unknownFareFallbackPaise[leg.mode] ?? 0),
      ),
    0,
  );
}

export function formatPaise(paise: number): string {
  assertPaise(paise);
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;
  return `₹${rupees}.${remainder.toString().padStart(2, "0")}`;
}