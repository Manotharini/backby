import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Constraints, Leg, ServiceWindow } from "../../shared/types";
import { assertPaise } from "../engine/money";
import { assertEpochMinute } from "../engine/time";

const RawFareSchema = z
  .object({
    minPaise: z.number().int().nonnegative().nullable(),
    maxPaise: z.number().int().nonnegative().nullable(),
    confidence: z.enum(["confirmed", "estimated", "unknown"]),
  })
  .superRefine((fare, context) => {
    if (fare.confidence === "unknown") {
      if (fare.minPaise !== null || fare.maxPaise !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unknown fares must have null minPaise and maxPaise",
        });
      }
      return;
    }
    if (fare.minPaise === null || fare.maxPaise === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "known fares must have integer minPaise and maxPaise",
      });
      return;
    }
    if (fare.maxPaise < fare.minPaise) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "maxPaise must be greater than or equal to minPaise",
      });
    }
  });

const RawServiceWindowSchema = z.object({
  first: z.number().int().nonnegative(),
  last: z.number().int().nonnegative(),
});

const RawModeDefaultSchema = z.object({
  serviceWindow: RawServiceWindowSchema,
  headwayMin: z.number().int().nonnegative(),
  waitAllowanceMin: z.number().int().nonnegative(),
  delayAllowanceMin: z.number().int().nonnegative(),
  nightSurcharge: z
    .object({
      fromMin: z.number().int().nonnegative(),
      toMin: z.number().int().nonnegative(),
      multiplier: z.number().positive(),
      note: z.string().optional(),
    })
    .optional(),
});

const RawLocationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  aliases: z.array(z.string()),
});

const RawEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  mode: z.string().min(1),
  durationMin: z.number().int().nonnegative(),
  serviceWindow: RawServiceWindowSchema.optional(),
  fare: RawFareSchema,
  note: z.string().optional(),
});

const DemoDatasetSchema = z.object({
  meta: z.object({
    name: z.string(),
    version: z.number().int(),
    disclaimer: z.string(),
    timeUnit: z.string(),
    moneyUnit: z.string(),
  }),
  modeDefaults: z.record(z.string(), RawModeDefaultSchema),
  unknownFareFallbackPaise: z.record(z.string(), z.number().int().nonnegative()),
  locations: z.array(RawLocationSchema),
  edges: z.array(RawEdgeSchema),
  edgeNotes: z.string(),
  testScenarios: z.array(
    z.object({
      id: z.string(),
      request: z.string().optional(),
      steps: z.string().optional(),
      expected: z.string(),
    }),
  ),
});

export type DemoDataset = z.infer<typeof DemoDatasetSchema>;
export type DemoLocation = DemoDataset["locations"][number];
type ModeDefault = DemoDataset["modeDefaults"][string];
type RawEdge = DemoDataset["edges"][number];

export interface DirectedEdge {
  id: string;
  baseEdgeId: string;
  from: string;
  to: string;
  mode: string;
  durationMin: number;
  fare: RawEdge["fare"];
  serviceWindow: ServiceWindow;
}

export interface RoutingRequest {
  from: string;
  to: string;
  departAt: number;
  allowedModes?: readonly string[] | undefined;
  maxTransfers?: number | undefined;
  blockedEdgeIds?: readonly string[] | undefined;
}

export interface Itinerary {
  legs: Leg[];
  departure: number;
  arrival: number;
  transfers: number;
}

export interface ProviderEngineDefaults {
  delayAllowances: Record<string, number>;
  unknownFareFallbackPaise: Record<string, number>;
}

export interface RoutingProvider {
  findItineraries(request: RoutingRequest): Promise<Itinerary[]>;
  search?(request: RoutingRequest): Promise<Itinerary[]>;
  resolvePlace(input: string): DemoLocation;
  getEngineDefaults?(): ProviderEngineDefaults;
}

const SCHEDULED_MODES = new Set(["bus", "metro", "suburban"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
export const ROUTING_UNAVAILABLE_ENV = "BACKBY_ROUTING_UNAVAILABLE";

function normalizePlace(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ");
}

function isNight(departAt: number, fromMin: number, toMin: number): boolean {
  return fromMin > toMin
    ? departAt >= fromMin || departAt <= toMin
    : departAt >= fromMin && departAt <= toMin;
}

function decimalToFraction(
  value: number,
): { numerator: bigint; denominator: bigint } {
  const text = String(value);
  const [whole, fraction = ""] = text.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  return {
    numerator:
      BigInt(whole ?? "0") * denominator + BigInt(fraction || 0),
    denominator,
  };
}

function multiplyPaise(paise: number, multiplier: number): number {
  const { numerator, denominator } = decimalToFraction(multiplier);
  const result =
    (BigInt(paise) * numerator + denominator - 1n) / denominator;
  return Number(result);
}

function fareForDeparture(
  edge: DirectedEdge,
  departAt: number,
  defaults: ModeDefault,
): Leg["fare"] {
  const rawFare = edge.fare;
  if (
    edge.mode !== "auto" ||
    !defaults.nightSurcharge ||
    !isNight(
      departAt,
      defaults.nightSurcharge.fromMin,
      defaults.nightSurcharge.toMin,
    )
  ) {
    return {
      min: rawFare.minPaise,
      max: rawFare.maxPaise,
      confidence: rawFare.confidence,
    };
  }

  return {
    min:
      rawFare.minPaise === null
        ? null
        : multiplyPaise(rawFare.minPaise, defaults.nightSurcharge.multiplier),
    max:
      rawFare.maxPaise === null
        ? null
        : multiplyPaise(rawFare.maxPaise, defaults.nightSurcharge.multiplier),
    confidence: rawFare.confidence,
  };
}

function nextScheduledDeparture(
  readyAt: number,
  serviceWindow: ServiceWindow,
  headwayMin: number,
): number | undefined {
  if (headwayMin <= 0) {
    throw new RangeError("scheduled modes must have a positive headwayMin");
  }
  if (readyAt > serviceWindow.last) return undefined;
  if (readyAt <= serviceWindow.first) return serviceWindow.first;
  const elapsed = readyAt - serviceWindow.first;
  const steps = Math.floor((elapsed + headwayMin - 1) / headwayMin);
  const departAt = serviceWindow.first + steps * headwayMin;
  return departAt <= serviceWindow.last ? departAt : undefined;
}

function nextDeparture(
  readyAt: number,
  edge: DirectedEdge,
  defaults: ModeDefault,
): number | undefined {
  if (SCHEDULED_MODES.has(edge.mode)) {
    return nextScheduledDeparture(
      readyAt,
      edge.serviceWindow,
      defaults.headwayMin,
    );
  }

  const wait = edge.mode === "auto" ? defaults.waitAllowanceMin : 0;
  const departAt = readyAt + wait;
  return departAt <= edge.serviceWindow.last ? departAt : undefined;
}

function edgeIsBlocked(
  edge: DirectedEdge,
  blockedEdgeIds: readonly string[] | undefined,
): boolean {
  if (!blockedEdgeIds) return false;
  return (
    blockedEdgeIds.includes(edge.id) ||
    blockedEdgeIds.includes(edge.baseEdgeId)
  );
}

export const DEFAULT_DEMO_DATA_PATH = path.resolve(
  process.cwd(),
  "data/chennai-demo.json",
);

export class MockProvider implements RoutingProvider {
  private readonly data: DemoDataset;
  private runtimeUnavailable = false;
  private readonly blockedEdgeIds = new Set<string>();
  private readonly expanded: DirectedEdge[];

  constructor(options: { dataPath?: string; unavailable?: boolean } = {}) {
    const dataPath = options.dataPath ?? DEFAULT_DEMO_DATA_PATH;
    const raw = fs.readFileSync(dataPath, "utf8");
    this.data = DemoDatasetSchema.parse(JSON.parse(raw));
    this.runtimeUnavailable = options.unavailable ?? false;
    this.expanded = this.data.edges.flatMap((edge) => {
      const serviceWindow =
        edge.serviceWindow ?? this.data.modeDefaults[edge.mode]?.serviceWindow;
      if (!serviceWindow) {
        throw new Error(`missing mode defaults for ${edge.mode}`);
      }
      return [
        {
          id: `${edge.id}:forward`,
          baseEdgeId: edge.id,
          from: edge.from,
          to: edge.to,
          mode: edge.mode,
          durationMin: edge.durationMin,
          fare: edge.fare,
          serviceWindow,
        },
        {
          id: `${edge.id}:reverse`,
          baseEdgeId: edge.id,
          from: edge.to,
          to: edge.from,
          mode: edge.mode,
          durationMin: edge.durationMin,
          fare: edge.fare,
          serviceWindow,
        },
      ];
    });
  }

  getDataset(): DemoDataset {
    return this.data;
  }

  getExpandedEdges(): readonly DirectedEdge[] {
    return this.expanded;
  }

  resolvePlace(input: string): DemoLocation {
    const needle = normalizePlace(input);
    const exact = this.data.locations.find((candidate) => {
      const names = [
        candidate.id,
        candidate.name,
        ...candidate.aliases,
      ].map(normalizePlace);
      return names.includes(needle);
    });
    const location =
      exact ??
      this.data.locations.find((candidate) => {
        const names = [
          candidate.id,
          candidate.name,
          ...candidate.aliases,
        ].map(normalizePlace);
        return names.some(
          (name) => needle.includes(name) || name.includes(needle),
        );
      });
    if (!location) throw new Error(`unknown place: ${input}`);
    return location;
  }

  getEngineDefaults(): ProviderEngineDefaults {
    return {
      delayAllowances: Object.fromEntries(
        Object.entries(this.data.modeDefaults).map(([mode, defaults]) => [
          mode,
          defaults.delayAllowanceMin,
        ]),
      ),
      unknownFareFallbackPaise: { ...this.data.unknownFareFallbackPaise },
    };
  }

  isRoutingUnavailable(): boolean {
    const configuredFlag =
      process.env[ROUTING_UNAVAILABLE_ENV] ??
      process.env.ROUTING_UNAVAILABLE;
    const flag = configuredFlag?.trim().toLocaleLowerCase();
    return this.runtimeUnavailable || (flag !== undefined && TRUE_VALUES.has(flag));
  }

  setRoutingUnavailable(unavailable: boolean): void {
    this.runtimeUnavailable = unavailable;
  }

  setUnavailable(unavailable: boolean): void {
    this.setRoutingUnavailable(unavailable);
  }

  toggleRoutingUnavailable(): boolean {
    this.runtimeUnavailable = !this.runtimeUnavailable;
    return this.runtimeUnavailable;
  }

  blockEdges(edgeIds: readonly string[]): void {
    edgeIds.forEach((edgeId) => this.blockedEdgeIds.add(edgeId));
  }

  unblockEdges(edgeIds: readonly string[]): void {
    edgeIds.forEach((edgeId) => this.blockedEdgeIds.delete(edgeId));
  }

  async findItineraries(request: RoutingRequest): Promise<Itinerary[]> {
    if (this.isRoutingUnavailable()) {
      throw new Error("routing unavailable");
    }

    assertEpochMinute(request.departAt, "request.departAt");
    const from = this.resolvePlace(request.from).id;
    const to = this.resolvePlace(request.to).id;
    if (from === to) return [];

    const maxTransfers = Math.max(
      0,
      Math.min(3, request.maxTransfers ?? 3),
    );
    const maxLegs = maxTransfers + 1;
    const allowedModes = request.allowedModes
      ? new Set(request.allowedModes)
      : undefined;
    const blockedEdgeIds = [
      ...this.blockedEdgeIds,
      ...(request.blockedEdgeIds ?? []),
    ];
    const results: Itinerary[] = [];

    const walk = (
      current: string,
      readyAt: number,
      legs: Leg[],
      visited: Set<string>,
    ): void => {
      if (current === to && legs.length > 0) {
        results.push({
          legs,
          departure: legs[0]?.depart ?? readyAt,
          arrival: legs.at(-1)?.arrive ?? readyAt,
          transfers: Math.max(0, legs.length - 1),
        });
        return;
      }
      if (legs.length >= maxLegs) return;

      for (const edge of this.expanded) {
        if (
          edge.from !== current ||
          visited.has(edge.to) ||
          edgeIsBlocked(edge, blockedEdgeIds) ||
          (allowedModes && !allowedModes.has(edge.mode))
        ) {
          continue;
        }
        const defaults = this.data.modeDefaults[edge.mode];
        if (!defaults) continue;
        const departAt = nextDeparture(readyAt, edge, defaults);
        if (departAt === undefined) continue;

        const arriveAt = departAt + edge.durationMin;
        const nextLeg: Leg = {
          id: edge.id,
          mode: edge.mode,
          from: edge.from,
          to: edge.to,
          depart: departAt,
          arrive: arriveAt,
          fare: fareForDeparture(edge, departAt, defaults),
          serviceWindow: edge.serviceWindow,
        };
        const nextVisited = new Set(visited);
        nextVisited.add(edge.to);
        walk(edge.to, arriveAt, [...legs, nextLeg], nextVisited);
      }
    };

    walk(from, request.departAt, [], new Set([from]));
    return results.sort(
      (left, right) =>
        left.arrival - right.arrival ||
        left.transfers - right.transfers ||
        left.departure - right.departure,
    );
  }

  search(request: RoutingRequest): Promise<Itinerary[]> {
    return this.findItineraries(request);
  }
}

export function constraintsWithProviderDefaults(
  constraints: Constraints,
  provider: RoutingProvider,
): Constraints {
  const defaults = provider.getEngineDefaults?.();
  if (!defaults) return constraints;
  return {
    ...constraints,
    delayAllowances: {
      ...defaults.delayAllowances,
      ...(constraints.delayAllowances ?? {}),
    },
    unknownFareFallbackPaise: {
      ...defaults.unknownFareFallbackPaise,
      ...(constraints.unknownFareFallbackPaise ?? {}),
    },
  };
}

export function assertProviderDefaultsArePaise(
  defaults: ProviderEngineDefaults,
): void {
  Object.values(defaults.unknownFareFallbackPaise).forEach((amount) =>
    assertPaise(amount, "unknown fare fallback"),
  );
}