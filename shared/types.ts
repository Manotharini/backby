import { z } from "zod";

export const FareConfidenceSchema = z.enum([
  "confirmed",
  "estimated",
  "unknown",
]);
export type FareConfidence = z.infer<typeof FareConfidenceSchema>;

export const FareSchema = z
  .object({
    min: z.number().int().nonnegative().nullable(),
    max: z.number().int().nonnegative().nullable(),
    confidence: FareConfidenceSchema,
  })
  .superRefine((fare, context) => {
    if (fare.confidence === "unknown") {
      if (fare.min !== null || fare.max !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unknown fares must have null min and max",
          path: ["min"],
        });
      }
      return;
    }

    if (fare.min === null || fare.max === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "known fares must have integer min and max",
        path: ["min"],
      });
      return;
    }

    if (fare.max < fare.min) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fare.max must be greater than or equal to fare.min",
        path: ["max"],
      });
    }
  });
export type Fare = z.infer<typeof FareSchema>;

export const ServiceWindowSchema = z.object({
  first: z.number().int().nonnegative(),
  last: z.number().int().nonnegative(),
});
export type ServiceWindow = z.infer<typeof ServiceWindowSchema>;

export const LegSchema = z.object({
  id: z.string().min(1),
  mode: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  depart: z.number().int().nonnegative(),
  arrive: z.number().int().nonnegative(),
  fare: FareSchema,
  serviceWindow: ServiceWindowSchema,
});
export type Leg = z.infer<typeof LegSchema>;

export const PlanSchema = z.object({
  outward: z.array(LegSchema),
  dwell: z.number().int().nonnegative(),
  return: z.array(LegSchema),
});
export type Plan = z.infer<typeof PlanSchema>;

const PreferencesSchema = z.object({
  allowedModes: z.array(z.string().min(1)).optional(),
});

export const ConstraintsSchema = z.object({
  budget: z.number().int().nonnegative(),
  reserve: z.number().int().nonnegative(),
  curfew: z.number().int().nonnegative(),
  allowedModes: z.array(z.string().min(1)).optional(),
  preferences: PreferencesSchema.optional(),
  allowUncertainty: z.boolean().default(false),
  fallbackReturnCost: z.number().int().nonnegative().optional(),
  unknownFareFallbackPaise: z
    .record(z.string(), z.number().int().nonnegative())
    .default({}),
  curfewBuffer: z.number().int().nonnegative().default(30),
  delayAllowances: z
    .record(z.string(), z.number().int().nonnegative())
    .default({}),
});
export type Constraints = z.infer<typeof ConstraintsSchema>;

export interface PlanCheck {
  name:
    | "continuity"
    | "eligibility"
    | "budget"
    | "reserve"
    | "curfew"
    | "unknown-fares";
  passed: boolean;
  actual: unknown;
  limit: unknown;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  checks: PlanCheck[];
}