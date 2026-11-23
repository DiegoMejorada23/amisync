import {
  CpModel,
  CpSat,
  LinearExpr,
  type BoolVar,
  type LinearExprLike,
} from 'or-tools-wasm/cp-sat';
import {
  PRIORITY_WEIGHT_MAP,
  WEEKDAYS,
  type AcademicPlanState,
  type BlockedTimeCell,
  type Weekday,
} from '../types/domain.ts';
import type { ForegroundConstraintRef } from '../types/solver.ts';
import type { DiagnosisExecutionOptions } from '../types/worker.ts';
import {
  sectionDatesOverlapBlockedCell,
  type PreprocessedCourse,
  type PreprocessedProblem,
} from './preprocess.ts';
import { mapCpSatStatus } from './wasmRuntime.ts';

export const DEFAULT_QUICKXPLAIN_TIME_LIMIT_SECONDS = 5.0;
export const DEFAULT_QUICKXPLAIN_PROBE_TIME_LIMIT_SECONDS = 2.0;
export const DEFAULT_QUICKXPLAIN_MAX_CHECKS = 256;

const UNIT_SCALE = 100;

/**
 * Thrown when QuickXplain breaches browser WASM memory bounds, wall-clock timeout,
 * or consistency-check budget, triggering SPEC.md Section 6.3 SOLVER_RESOURCE_FALLBACK.
 */
export class QuickXplainFallbackError extends Error {
  readonly reason: 'TIMEOUT' | 'MAX_CHECKS' | 'WASM_RUNTIME_ERROR';

  constructor(
    reason: 'TIMEOUT' | 'MAX_CHECKS' | 'WASM_RUNTIME_ERROR',
    message: string
  ) {
    super(message);
    this.name = 'QuickXplainFallbackError';
    this.reason = reason;
  }
}

export interface QuickXplainBudget {
  readonly startMs: number;
  readonly deadlineMs: number;
  readonly maxConsistencyChecks: number;
  readonly probeTimeLimitSeconds: number;
  readonly randomSeed?: number;
  consistencyChecks: number;
}

export function createQuickXplainBudget(
  options?: Pick<
    DiagnosisExecutionOptions,
    'maxTimeInSeconds' | 'probeTimeLimitSeconds' | 'maxConsistencyChecks' | 'randomSeed'
  >
): QuickXplainBudget {
  const startMs = performance.now();
  const maxTimeSec = options?.maxTimeInSeconds ?? DEFAULT_QUICKXPLAIN_TIME_LIMIT_SECONDS;
  const probeTimeSec =
    options?.probeTimeLimitSeconds ?? DEFAULT_QUICKXPLAIN_PROBE_TIME_LIMIT_SECONDS;
  const maxChecks = options?.maxConsistencyChecks ?? DEFAULT_QUICKXPLAIN_MAX_CHECKS;

  return {
    startMs,
    deadlineMs: startMs + Math.max(0, maxTimeSec) * 1000,
    maxConsistencyChecks: Math.max(1, Math.floor(maxChecks)),
    probeTimeLimitSeconds: Math.max(0.05, probeTimeSec),
    randomSeed: options?.randomSeed,
    consistencyChecks: 0,
  };
}

export function assertQuickXplainBudget(budget: QuickXplainBudget): void {
  if (performance.now() > budget.deadlineMs) {
    throw new QuickXplainFallbackError(
      'TIMEOUT',
      'QuickXplain exceeded wall-clock execution time budget.'
    );
  }
  if (budget.consistencyChecks >= budget.maxConsistencyChecks) {
    throw new QuickXplainFallbackError(
      'MAX_CHECKS',
      `QuickXplain exceeded maximum consistency check limit (${budget.maxConsistencyChecks}).`
    );
  }
}

export type ConsistencyOracle<T> = (
  constraints: readonly T[],
  budget: QuickXplainBudget
) => Promise<boolean> | boolean;

export type QuickXplainStatus = 'MUS_FOUND' | 'BACKGROUND_INCONSISTENT' | 'CONSISTENT';

export interface QuickXplainResult<T> {
  status: QuickXplainStatus;
  mus: T[];
  consistencyChecks: number;
}

interface InternalOracleContext<T> {
  isConsistent: ConsistencyOracle<T>;
  budget: QuickXplainBudget;
  getKey?: (item: T) => string;
  cache: Map<string, boolean>;
}

async function probeConsistency<T>(
  subset: readonly T[],
  ctx: InternalOracleContext<T>
): Promise<boolean> {
  if (ctx.getKey) {
    const cacheKey = subset
      .map((c) => ctx.getKey!(c))
      .sort()
      .join('|');
    const cached = ctx.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    assertQuickXplainBudget(ctx.budget);
    ctx.budget.consistencyChecks += 1;

    try {
      const sat = await ctx.isConsistent(subset, ctx.budget);
      ctx.cache.set(cacheKey, sat);
      return sat;
    } catch (err) {
      if (err instanceof QuickXplainFallbackError) {
        throw err;
      }
      throw new QuickXplainFallbackError(
        'WASM_RUNTIME_ERROR',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  assertQuickXplainBudget(ctx.budget);
  ctx.budget.consistencyChecks += 1;

  try {
    return await ctx.isConsistent(subset, ctx.budget);
  } catch (err) {
    if (err instanceof QuickXplainFallbackError) {
      throw err;
    }
    throw new QuickXplainFallbackError(
      'WASM_RUNTIME_ERROR',
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Recursive divide-and-conquer QuickXplain core (Junker, 2004; SPEC.md Section 6.3).
 *
 * Precondition: B ∪ C is inconsistent and B \ delta is consistent.
 * Ordering: C is ordered from highest priority (index 0) to lowest priority (index n-1).
 * Returns a priority-preferred Minimal Unsatisfiable Subset (MUS) X ⊆ C with respect to B.
 */
async function qx<T>(
  B: readonly T[],
  delta: readonly T[],
  C: readonly T[],
  ctx: InternalOracleContext<T>
): Promise<T[]> {
  assertQuickXplainBudget(ctx.budget);

  // Base case 1: background B already became inconsistent after adding non-empty delta
  if (delta.length > 0 && !(await probeConsistency(B, ctx))) {
    return [];
  }

  // Base case 2: single remaining constraint in C must belong to the MUS
  if (C.length === 1) {
    return [C[0]];
  }

  // Divide C into higher-priority prefix C1 and lower-priority suffix C2
  const k = Math.floor(C.length / 2);
  const C1 = C.slice(0, k);
  const C2 = C.slice(k);

  // First isolate conflicting constraints in lower-priority half C2 (preserving C1)
  const X2 = await qx([...B, ...C1], C1, C2, ctx);

  // Then isolate minimal conflicting constraints in higher-priority half C1 given X2
  const X1 = await qx([...B, ...X2], X2, C1, ctx);

  return [...X1, ...X2];
}

/**
 * Executes QuickXplain (Junker, 2004) over immutable background constraints `B` and
 * priority-ordered relaxable foreground constraints `C` (highest priority at index 0).
 */
export async function quickXplain<T>(
  B: readonly T[],
  C: readonly T[],
  isConsistent: ConsistencyOracle<T>,
  budget: QuickXplainBudget = createQuickXplainBudget(),
  getKey?: (item: T) => string
): Promise<QuickXplainResult<T>> {
  const ctx: InternalOracleContext<T> = {
    isConsistent,
    budget,
    getKey,
    cache: new Map<string, boolean>(),
  };

  // Tier 1: verify Background Set B consistency first.
  const backgroundConsistent = await probeConsistency(B, ctx);
  if (!backgroundConsistent) {
    return {
      status: 'BACKGROUND_INCONSISTENT',
      mus: [],
      consistencyChecks: budget.consistencyChecks,
    };
  }

  if (C.length === 0) {
    return {
      status: 'CONSISTENT',
      mus: [],
      consistencyChecks: budget.consistencyChecks,
    };
  }

  // Verify B ∪ C is actually inconsistent before recursing.
  const combinedConsistent = await probeConsistency([...B, ...C], ctx);
  if (combinedConsistent) {
    return {
      status: 'CONSISTENT',
      mus: [],
      consistencyChecks: budget.consistencyChecks,
    };
  }

  const mus = await qx(B, [], C, ctx);
  return {
    status: 'MUS_FOUND',
    mus,
    consistencyChecks: budget.consistencyChecks,
  };
}

/** Alias matching prompt/domain terminology for isolating a minimal conflict set. */
export const findMinimalConflict = quickXplain;

// ============================================================================
// Domain-Specific Constraint Partitioning & Pure-SAT CP-SAT Oracle
// ============================================================================

export interface MergedBlockedWindow {
  id: string;
  day: Weekday;
  startMinutes: number;
  endMinutes: number;
  sourceCellIds: string[];
}

/**
 * Merges contiguous or overlapping BlockedTimeCells on the same weekday into atomic
 * time-block windows (e.g., Tue 1-2, 2-3, 3-4 PM -> Tue 1:00 PM - 4:00 PM) so QuickXplain
 * isolates complete actionable windows matching SPEC.md Section 6.4 and Paper Files/2.0.png.
 */
export function mergeContiguousBlockedCells(
  blockedCells: readonly BlockedTimeCell[]
): MergedBlockedWindow[] {
  const byDay = new Map<Weekday, BlockedTimeCell[]>();
  for (const day of WEEKDAYS) {
    byDay.set(day, []);
  }
  for (const cell of blockedCells) {
    if (cell.endMinutes <= cell.startMinutes) continue;
    const list = byDay.get(cell.day);
    if (list) list.push(cell);
  }

  const merged: MergedBlockedWindow[] = [];

  for (const day of WEEKDAYS) {
    const cells = byDay.get(day)!;
    if (cells.length === 0) continue;

    cells.sort(
      (a, b) =>
        a.startMinutes - b.startMinutes ||
        a.endMinutes - b.endMinutes ||
        a.id.localeCompare(b.id)
    );

    let currentStart = cells[0].startMinutes;
    let currentEnd = cells[0].endMinutes;
    let currentIds = [cells[0].id];

    for (let i = 1; i < cells.length; i++) {
      const next = cells[i];
      if (next.startMinutes <= currentEnd) {
        currentEnd = Math.max(currentEnd, next.endMinutes);
        currentIds.push(next.id);
      } else {
        merged.push({
          id: `${day}:${currentStart}-${currentEnd}`,
          day,
          startMinutes: currentStart,
          endMinutes: currentEnd,
          sourceCellIds: currentIds,
        });
        currentStart = next.startMinutes;
        currentEnd = next.endMinutes;
        currentIds = [next.id];
      }
    }

    merged.push({
      id: `${day}:${currentStart}-${currentEnd}`,
      day,
      startMinutes: currentStart,
      endMinutes: currentEnd,
      sourceCellIds: currentIds,
    });
  }

  return merged;
}

export interface ForegroundConstraintItem {
  key: string;
  ref: ForegroundConstraintRef;
  /** Internal tie-breaker rank (higher = preserved earlier on equal priorityWeight). */
  kindRank: number;
  /** Original deterministic insertion order. */
  orderIndex: number;
  /** For INTENDED_COURSE */
  courseKey?: string;
  /** For TIME_BLOCK */
  affectedNodeIndices?: number[];
  sourceCellIds?: string[];
  /** For HIDDEN_SECTION / USER_LOCKED_SECTION */
  nodeIndex?: number;
}

const DEFAULT_BASE_PRIORITY = {
  INTENDED_COURSE: 100,
  USER_LOCKED_SECTION: 80,
  TIME_BLOCK: 60,
  HIDDEN_SECTION: 40,
} as const;

const KIND_TIE_RANK = {
  INTENDED_COURSE: 4,
  USER_LOCKED_SECTION: 3,
  TIME_BLOCK: 2,
  HIDDEN_SECTION: 1,
} as const;

function courseHasPreEnlistedNode(
  problem: PreprocessedProblem,
  course: PreprocessedCourse
): boolean {
  for (const indices of course.nodeIndicesByComponent.values()) {
    for (const idx of indices) {
      if (problem.nodes[idx].isPreEnlisted) {
        return true;
      }
    }
  }
  return false;
}

function lookupPriorityOverride(
  overrides: Record<string, number> | undefined,
  keys: readonly string[]
): number | undefined {
  if (!overrides) return undefined;
  let found: number | undefined;
  for (const k of keys) {
    const val = overrides[k];
    if (typeof val === 'number' && Number.isFinite(val)) {
      found = found === undefined ? val : Math.max(found, val);
    }
  }
  return found;
}

/**
 * Extracts all relaxable Foreground Set C constraints from the preprocessed problem and plan,
 * assigning deterministic user-aligned priority weights and sorting descending (highest priority first).
 */
export function buildForegroundConstraints(
  problem: PreprocessedProblem,
  plan: AcademicPlanState,
  options?: Pick<DiagnosisExecutionOptions, 'constraintPriorities'>
): ForegroundConstraintItem[] {
  const overrides = options?.constraintPriorities;
  const items: ForegroundConstraintItem[] = [];
  let orderIndex = 0;

  // 1. Intended Courses (component satisfaction requirement per intended course)
  for (const course of problem.courses) {
    if (course.isPreEnlistedCourse || courseHasPreEnlistedNode(problem, course)) {
      continue;
    }

    const custom = lookupPriorityOverride(overrides, [
      `INTENDED_COURSE:${course.courseId}`,
      `INTENDED_COURSE:${course.courseCode}`,
      course.courseKey,
      course.courseId,
      course.courseCode,
    ]);
    const priorityWeight = custom ?? DEFAULT_BASE_PRIORITY.INTENDED_COURSE;

    items.push({
      key: `INTENDED_COURSE:${course.courseKey}`,
      ref: {
        kind: 'INTENDED_COURSE',
        courseId: course.courseId,
        courseCode: course.courseCode,
        priorityWeight,
      },
      kindRank: KIND_TIE_RANK.INTENDED_COURSE,
      orderIndex: orderIndex++,
      courseKey: course.courseKey,
    });
  }

  // 2. Merged Visual Time Blocks
  const mergedWindows = mergeContiguousBlockedCells(plan.blockedCells);
  const fridayBonus = PRIORITY_WEIGHT_MAP[plan.preferences.minimizeFridayClasses.priority];
  const boundsBonus = PRIORITY_WEIGHT_MAP[plan.preferences.acceptableDayBounds.priority];
  const prefStart = plan.preferences.acceptableDayBounds.earliestStartMinutes;
  const prefEnd = plan.preferences.acceptableDayBounds.latestEndMinutes;

  for (const win of mergedWindows) {
    const affectedNodeIndices: number[] = [];
    const syntheticCell: BlockedTimeCell = {
      id: win.id,
      day: win.day,
      startMinutes: win.startMinutes,
      endMinutes: win.endMinutes,
    };
    for (const node of problem.nodes) {
      if (sectionDatesOverlapBlockedCell(node.dates, syntheticCell)) {
        affectedNodeIndices.push(node.nodeIndex);
      }
    }

    const custom = lookupPriorityOverride(overrides, [
      `TIME_BLOCK:${win.id}`,
      win.id,
      ...win.sourceCellIds,
      win.day,
    ]);

    let defaultWeight = DEFAULT_BASE_PRIORITY.TIME_BLOCK;
    if (win.day === 'Friday') {
      defaultWeight += fridayBonus;
    }
    if (win.startMinutes < prefStart || win.endMinutes > prefEnd) {
      defaultWeight += boundsBonus;
    }

    const priorityWeight = custom ?? defaultWeight;

    items.push({
      key: `TIME_BLOCK:${win.id}`,
      ref: {
        kind: 'TIME_BLOCK',
        blockId: win.id,
        day: win.day,
        startMinutes: win.startMinutes,
        endMinutes: win.endMinutes,
        priorityWeight,
      },
      kindRank: KIND_TIE_RANK.TIME_BLOCK,
      orderIndex: orderIndex++,
      affectedNodeIndices,
      sourceCellIds: win.sourceCellIds,
    });
  }

  // 3. User-Locked Sections (UI Padlock) & User-Hidden Sections (UI Eye)
  for (const node of problem.nodes) {
    if (node.isPreEnlisted) {
      continue;
    }

    if (node.flags.isLocked) {
      const custom = lookupPriorityOverride(overrides, [
        `USER_LOCKED_SECTION:${node.sectionId}`,
        `LOCK:${node.sectionId}`,
        node.varKey,
        node.sectionId,
      ]);
      const priorityWeight = custom ?? DEFAULT_BASE_PRIORITY.USER_LOCKED_SECTION;

      items.push({
        key: `USER_LOCKED_SECTION:${node.varKey}`,
        ref: {
          kind: 'USER_LOCKED_SECTION',
          courseId: node.courseId,
          courseCode: node.courseCode,
          sectionId: node.sectionId,
          sectionName: node.sectionName,
          priorityWeight,
        },
        kindRank: KIND_TIE_RANK.USER_LOCKED_SECTION,
        orderIndex: orderIndex++,
        nodeIndex: node.nodeIndex,
      });
    }

    if (node.flags.isHidden) {
      const custom = lookupPriorityOverride(overrides, [
        `HIDDEN_SECTION:${node.sectionId}`,
        `HIDE:${node.sectionId}`,
        node.varKey,
        node.sectionId,
      ]);
      const priorityWeight = custom ?? DEFAULT_BASE_PRIORITY.HIDDEN_SECTION;

      items.push({
        key: `HIDDEN_SECTION:${node.varKey}`,
        ref: {
          kind: 'HIDDEN_SECTION',
          courseId: node.courseId,
          courseCode: node.courseCode,
          sectionId: node.sectionId,
          sectionName: node.sectionName,
          priorityWeight,
        },
        kindRank: KIND_TIE_RANK.HIDDEN_SECTION,
        orderIndex: orderIndex++,
        nodeIndex: node.nodeIndex,
      });
    }
  }

  // Sort strictly descending by priorityWeight (highest priority at index 0) with deterministic tie-breakers.
  items.sort((a, b) => {
    if (b.ref.priorityWeight !== a.ref.priorityWeight) {
      return b.ref.priorityWeight - a.ref.priorityWeight;
    }
    if (b.kindRank !== a.kindRank) {
      return b.kindRank - a.kindRank;
    }
    return a.orderIndex - b.orderIndex;
  });

  return items;
}

export interface BuiltPureSatModel {
  model: CpModel;
  xVars: BoolVar[];
  triviallyInfeasible: boolean;
}

/**
 * Constructs a lightweight Pure Satisfiability (Z = 0) CP-SAT model enforcing:
 * - Immutable Background Set B: pre-enlisted anchors, temporal exclusivity (Eq. 4–5),
 *   co-requisite parent-child linkage (Eq. 3), at-most-one / all-or-nothing course integrity,
 *   and academic unit bounds.
 * - Active Foreground Subset S ⊆ C: intended course enrollment requirements, active time-blocks,
 *   active hidden sections, and active user-locked sections.
 */
export function buildPureSatSubsetModel(
  problem: PreprocessedProblem,
  activeForeground: readonly ForegroundConstraintItem[]
): BuiltPureSatModel {
  const model = new CpModel();
  const xVars: BoolVar[] = problem.nodes.map((node) =>
    model.newBoolVar(`sat_x_${node.nodeIndex}_${node.sectionId}`)
  );

  let triviallyInfeasible = false;

  // =========================================================================
  // IMMUTABLE BACKGROUND SET B
  // =========================================================================

  // 1. Pre-enlisted anchor constants (Eq. 1): x_{c,k,s} = 1
  for (const node of problem.nodes) {
    if (node.isPreEnlisted) {
      model.addEquality(xVars[node.nodeIndex], 1);
    }
  }

  // 2. Course structural integrity & co-requisite linkage (Eq. 3)
  const activeIntendedCourseKeys = new Set<string>();
  for (const item of activeForeground) {
    if (item.ref.kind === 'INTENDED_COURSE' && item.courseKey) {
      activeIntendedCourseKeys.add(item.courseKey);
    }
  }

  for (const course of problem.courses) {
    const isMandatoryInB =
      course.isPreEnlistedCourse || courseHasPreEnlistedNode(problem, course);
    const isRequiredActive = isMandatoryInB || activeIntendedCourseKeys.has(course.courseKey);

    const componentIndexLists: number[][] = [];
    for (const comp of course.requiredComponents) {
      const indices = course.nodeIndicesByComponent.get(comp) ?? [];
      componentIndexLists.push(indices);

      if (isRequiredActive) {
        if (indices.length === 0) {
          triviallyInfeasible = true;
          model.addLinearConstraint(0, 1, 1);
        } else if (indices.length === 1) {
          model.addEquality(xVars[indices[0]], 1);
        } else {
          model.addExactlyOne(indices.map((idx) => xVars[idx]));
        }
      } else {
        // Optional course when not active in foreground subset: at most one section per component.
        if (indices.length >= 2) {
          model.addAtMostOne(indices.map((idx) => xVars[idx]));
        }
      }
    }

    // All-or-nothing coupling across required components of an optional course in B
    if (!isRequiredActive && componentIndexLists.length >= 2) {
      const hasEmptyComp = componentIndexLists.some((list) => list.length === 0);
      if (hasEmptyComp) {
        // Cannot enroll in this course at all if a required component is empty
        for (const list of componentIndexLists) {
          for (const idx of list) {
            model.addEquality(xVars[idx], 0);
          }
        }
      } else {
        const firstSum = LinearExpr.sum(componentIndexLists[0].map((idx) => xVars[idx]));
        for (let cIdx = 1; cIdx < componentIndexLists.length; cIdx++) {
          const otherSum = LinearExpr.sum(componentIndexLists[cIdx].map((idx) => xVars[idx]));
          model.addEquality(otherSum, firstSum);
        }
      }
    }

    // Eq. (3): Parent-child co-requisite linkage
    for (const group of course.linkageGroups) {
      const parentVar = xVars[group.parentNodeIndex];
      if (group.childNodeIndices.length === 0) {
        model.addEquality(parentVar, 0);
      } else if (group.childNodeIndices.length === 1) {
        model.addEquality(xVars[group.childNodeIndices[0]], parentVar);
      } else {
        model.addEquality(
          LinearExpr.sum(group.childNodeIndices.map((idx) => xVars[idx])),
          parentVar
        );
      }
    }
  }

  // 3. Pairwise Temporal Exclusivity (Eq. 4 & Eq. 5)
  for (const [i, j] of problem.overlappingPairs) {
    model.addAtMostOne([xVars[i], xVars[j]]);
  }

  // 4. Optional Academic Plan Unit Limits
  if (problem.unitLimits) {
    const { minUnits, maxUnits } = problem.unitLimits;
    const hasMin = typeof minUnits === 'number' && Number.isFinite(minUnits);
    const hasMax = typeof maxUnits === 'number' && Number.isFinite(maxUnits);

    if (hasMin || hasMax) {
      const unitTerms: LinearExprLike[] = [];
      const unitCoeffs: number[] = [];

      for (const course of problem.courses) {
        const scaledUnits = Math.round(course.units * UNIT_SCALE);
        if (scaledUnits <= 0) continue;

        const repComp = course.requiredComponents[0];
        const repIndices = repComp ? course.nodeIndicesByComponent.get(repComp) ?? [] : [];
        for (const idx of repIndices) {
          unitTerms.push(xVars[idx]);
          unitCoeffs.push(scaledUnits);
        }
      }

      const lb = hasMin ? Math.round(minUnits * UNIT_SCALE) : 0;
      const ub = hasMax ? Math.round(maxUnits * UNIT_SCALE) : Number.MAX_SAFE_INTEGER;

      if (lb > ub) {
        triviallyInfeasible = true;
        model.addLinearConstraint(0, 1, 1);
      } else if (unitTerms.length === 0) {
        if (lb > 0) {
          triviallyInfeasible = true;
          model.addLinearConstraint(0, 1, 1);
        }
      } else {
        model.addLinearConstraint(LinearExpr.weightedSum(unitTerms, unitCoeffs), lb, ub);
      }
    }
  }

  // =========================================================================
  // ACTIVE RELAXABLE FOREGROUND CONSTRAINTS S ⊆ C
  // =========================================================================

  for (const item of activeForeground) {
    switch (item.ref.kind) {
      case 'INTENDED_COURSE':
        // Already enforced above via activeIntendedCourseKeys
        break;
      case 'TIME_BLOCK':
        if (item.affectedNodeIndices) {
          for (const nodeIdx of item.affectedNodeIndices) {
            model.addEquality(xVars[nodeIdx], 0);
          }
        }
        break;
      case 'HIDDEN_SECTION':
        if (item.nodeIndex !== undefined) {
          model.addEquality(xVars[item.nodeIndex], 0);
        }
        break;
      case 'USER_LOCKED_SECTION':
        if (item.nodeIndex !== undefined) {
          model.addEquality(xVars[item.nodeIndex], 1);
        }
        break;
    }
  }

  // Pure Satisfiability Mode: Z = 0 (no objective added)
  return {
    model,
    xVars,
    triviallyInfeasible,
  };
}

/**
 * CP-SAT WASM consistency oracle executing strictly in Pure Satisfiability Mode (Z = 0)
 * on a single worker thread (`executor: 'direct'`, `numWorkers: 1`).
 */
export async function checkSubsetConsistencyPureSat(
  problem: PreprocessedProblem,
  activeForeground: readonly ForegroundConstraintItem[],
  budget: QuickXplainBudget
): Promise<boolean> {
  const built = buildPureSatSubsetModel(problem, activeForeground);
  if (built.triviallyInfeasible) {
    return false;
  }

  const remainingSec = Math.max(0.05, (budget.deadlineMs - performance.now()) / 1000);
  const probeLimit = Math.min(budget.probeTimeLimitSeconds, remainingSec);

  const cpResult = await CpSat.solve(built.model, {
    executor: 'direct',
    numWorkers: 1,
    maxTimeInSeconds: probeLimit,
    ...(budget.randomSeed !== undefined ? { randomSeed: budget.randomSeed } : {}),
  });

  const status = mapCpSatStatus(
    typeof cpResult.statusName === 'function'
      ? cpResult.statusName()
      : String(cpResult.status)
  );

  if (status === 'OPTIMAL' || status === 'FEASIBLE') {
    return true;
  }
  if (status === 'INFEASIBLE') {
    return false;
  }

  throw new QuickXplainFallbackError(
    'TIMEOUT',
    `Pure-SAT CP-SAT consistency probe terminated with status ${status}.`
  );
}

export interface MusVerificationReport {
  /** True iff B ∪ MUS is unsatisfiable. */
  isUnsatisfiable: boolean;
  /** True iff removing ANY single constraint c ∈ MUS restores satisfiability of B ∪ (MUS \ {c}). */
  isIrreducible: boolean;
  /** True iff both unsatisfiability and irreducibility hold (valid MUS). */
  isValidMus: boolean;
  /** Keys of any redundant constraints whose removal still leaves B ∪ (MUS \ {c}) unsatisfiable. */
  redundantConstraintKeys: string[];
}

/**
 * Independently verifies the two formal mathematical properties of an extracted MUS:
 * 1. Unsatisfiability: B ∪ MUS is UNSAT.
 * 2. Irreducibility: ∀ c ∈ MUS, B ∪ (MUS \ {c}) is SAT.
 * Supports thesis evaluation criteria in SPEC.md Section 1.2 & Section 9 Phase 4.
 */
export async function verifyMusProperties(
  problem: PreprocessedProblem,
  musItems: readonly ForegroundConstraintItem[],
  budget: QuickXplainBudget = createQuickXplainBudget()
): Promise<MusVerificationReport> {
  const fullSat = await checkSubsetConsistencyPureSat(problem, musItems, budget);
  const isUnsatisfiable = !fullSat;
  const redundantConstraintKeys: string[] = [];

  for (let i = 0; i < musItems.length; i++) {
    const withoutOne = musItems.filter((_, idx) => idx !== i);
    const satWithout = await checkSubsetConsistencyPureSat(problem, withoutOne, budget);
    if (!satWithout) {
      redundantConstraintKeys.push(musItems[i].key);
    }
  }

  const isIrreducible = musItems.length > 0 && redundantConstraintKeys.length === 0;
  return {
    isUnsatisfiable,
    isIrreducible,
    isValidMus: isUnsatisfiable && isIrreducible,
    redundantConstraintKeys,
  };
}
