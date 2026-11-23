import {
  CpSat,
  setCloudNoticeEnabled,
  setSingleThreadWarningEnabled,
} from 'or-tools-wasm/cp-sat';
import type {
  AcademicPlanState,
  StudentPreferences,
} from '../types/domain.ts';
import type {
  GeneratedScheduleAlternative,
  InfeasibilityDiagnosis,
  SolverResponsePayload,
  SolverTerminalStatus,
} from '../types/solver.ts';
import type {
  DiagnosisExecutionOptions,
  SolverExecutionOptions,
} from '../types/worker.ts';
import { diagnosePreprocessedProblem } from './diagnosis.ts';
import { buildCpSatModel, type ExclusionCut } from './modelBuilder.ts';
import {
  computeObjectiveWeights,
  evaluateSelectionObjective,
} from './objective.ts';
import { preprocessAcademicPlan } from './preprocess.ts';
import {
  ensureWasmInitialized,
  getCachedWasmInitMs,
  mapCpSatStatus,
} from './wasmRuntime.ts';

setSingleThreadWarningEnabled(false);
setCloudNoticeEnabled(false);

export const DEFAULT_SOLVER_TIME_LIMIT_SECONDS = 10.0;

export { ensureWasmInitialized, getCachedWasmInitMs };

/**
 * Computes Hamming distance D between two schedules over flexible (non-pre-enlisted) Boolean variables.
 */
export function computeHammingDistance(
  setA: ReadonlySet<number>,
  setB: ReadonlySet<number>
): number {
  let diff = 0;
  for (const idx of setA) {
    if (!setB.has(idx)) diff += 1;
  }
  for (const idx of setB) {
    if (!setA.has(idx)) diff += 1;
  }
  return diff;
}

interface SearchProfile {
  planLabel: string;
  profileTag: string;
  preferences: StudentPreferences;
}

const PLAN_LABELS = ['Plan A', 'Plan B', 'Plan C'] as const;

function clonePreferences(prefs: StudentPreferences): StudentPreferences {
  return {
    fatigueLimit: { ...prefs.fatigueLimit },
    acceptableDayBounds: { ...prefs.acceptableDayBounds },
    minimizeFridayClasses: { ...prefs.minimizeFridayClasses },
    batchSubjectsToFewerDays: { ...prefs.batchSubjectsToFewerDays },
    minimizeExcessiveGaps: { ...prefs.minimizeExcessiveGaps },
    starredSectionPreference: { ...prefs.starredSectionPreference },
  };
}

function buildSearchProfile(
  alternativeIndex: number,
  basePreferences: StudentPreferences,
  alternateProfiles: boolean,
  isPureSat: boolean
): SearchProfile {
  const planLabel = PLAN_LABELS[alternativeIndex] ?? `Plan ${alternativeIndex + 1}`;

  if (isPureSat) {
    return {
      planLabel,
      profileTag: 'Pure SAT',
      preferences: basePreferences,
    };
  }

  if (!alternateProfiles || alternativeIndex === 0) {
    return {
      planLabel,
      profileTag: 'Balanced',
      preferences: basePreferences,
    };
  }

  if (alternativeIndex === 1) {
    const compact = clonePreferences(basePreferences);
    compact.batchSubjectsToFewerDays.priority = 'High';
    compact.minimizeFridayClasses.priority = 'High';
    return {
      planLabel,
      profileTag: 'Compact Days',
      preferences: compact,
    };
  }

  const lowFatigue = clonePreferences(basePreferences);
  lowFatigue.fatigueLimit.priority = 'High';
  lowFatigue.minimizeExcessiveGaps.priority = 'High';
  lowFatigue.acceptableDayBounds.priority = 'High';
  return {
    planLabel,
    profileTag: 'Low Fatigue & Gaps',
    preferences: lowFatigue,
  };
}

function resolveDiagnosisOptions(
  options?: SolverExecutionOptions
): DiagnosisExecutionOptions {
  return {
    ...(options?.diagnosis ?? {}),
    unitLimits: options?.diagnosis?.unitLimits ?? options?.unitLimits,
    ...(options?.diagnosis?.randomSeed === undefined && options?.randomSeed !== undefined
      ? { randomSeed: options.randomSeed }
      : {}),
  };
}

/**
 * Runs Phase 1 CP-SAT optimization with iterative exclusion (SPEC.md Sections 5.1–5.6)
 * and automatically triggers Phase 2 QuickXplain Conflict Diagnosis (SPEC.md Section 6)
 * whenever the initial solve is INFEASIBLE:
 * - Enforces single-threaded local WASM execution (`executor: 'direct'`, `numWorkers: 1`).
 * - Enforces per-solve heuristic time limit (`10.0s` default).
 * - Generates up to 3 structurally distinct schedules (`Plan A`, `Plan B`, `Plan C`)
 *   satisfying Eq. (16) exclusion cuts and Hamming distance verification (`D >= 2` / `D >= 4`).
 * - Automatically runs 3-tier conflict triage + QuickXplain MUS extraction + fallback options
 *   when no feasible schedule exists.
 */
export async function solveAcademicPlan(
  plan: AcademicPlanState,
  options?: SolverExecutionOptions
): Promise<SolverResponsePayload> {
  const { coldStartMs } = await ensureWasmInitialized();

  const preprocessStart = performance.now();
  const problem = preprocessAcademicPlan(plan, options?.unitLimits);
  let modelConstructionMs = performance.now() - preprocessStart;
  let solverExecutionMs = 0;
  const diagOptions = resolveDiagnosisOptions(options);

  // Tier 1 / Tier 2 Preprocessing Early Check: Exhausted capacity before CP-SAT variable creation.
  if (problem.exhaustedCourses.length > 0) {
    const diagResult = await diagnosePreprocessedProblem(plan, problem, diagOptions);
    return {
      status: 'INFEASIBLE',
      alternatives: [],
      diagnosis: diagResult.diagnosis,
      timing: {
        wasmInitMs: coldStartMs,
        modelConstructionMs: Number(modelConstructionMs.toFixed(2)),
        solverExecutionMs: 0,
        musExtractionMs: diagResult.musExtractionMs,
      },
    };
  }

  // Empty plan edge case (no pre-enlisted or intended courses).
  if (problem.courses.length === 0) {
    const minUnits = problem.unitLimits?.minUnits ?? 0;
    if (minUnits > 0) {
      const diagResult = options?.skipDiagnosis
        ? null
        : await diagnosePreprocessedProblem(plan, problem, diagOptions);
      return {
        status: 'INFEASIBLE',
        alternatives: [],
        diagnosis: diagResult?.diagnosis ?? null,
        timing: {
          wasmInitMs: coldStartMs,
          modelConstructionMs: Number(modelConstructionMs.toFixed(2)),
          solverExecutionMs: 0,
          ...(diagResult ? { musExtractionMs: diagResult.musExtractionMs } : {}),
        },
      };
    }

    return {
      status: 'OPTIMAL',
      alternatives: [
        {
          planLabel: 'Plan A',
          profileTag: 'Balanced',
          totalUnits: 0,
          status: 'OPTIMAL',
          objectiveScoreZ: 0,
          selectedSectionIds: [],
          hammingDistanceFromPrev: [],
        },
      ],
      diagnosis: null,
      timing: {
        wasmInitMs: coldStartMs,
        modelConstructionMs: Number(modelConstructionMs.toFixed(2)),
        solverExecutionMs: 0,
      },
    };
  }

  const maxTimeInSeconds = options?.maxTimeInSeconds ?? DEFAULT_SOLVER_TIME_LIMIT_SECONDS;
  const maxAlternatives = Math.min(3, Math.max(1, Math.floor(plan.diversity.maxAlternatives || 3)));
  const minDiff = Math.max(1, Math.floor(plan.diversity.minDifferingSections || 1));
  const minHamming = Math.max(
    2 * minDiff,
    Math.floor(plan.diversity.minHammingDistance || 2 * minDiff)
  );
  const effectiveCutMinDiff = Math.max(minDiff, Math.ceil(minHamming / 2));

  const baseWeights = computeObjectiveWeights(problem, plan.preferences);
  const exclusionCuts: ExclusionCut[] = [];
  const acceptedFlexibleSets: Array<Set<number>> = [];
  const alternatives: GeneratedScheduleAlternative[] = [];

  const maxLoopAttempts = maxAlternatives + 6;
  let attempts = 0;
  let firstRunTerminalStatus: SolverTerminalStatus = 'INFEASIBLE';

  while (alternatives.length < maxAlternatives && attempts < maxLoopAttempts) {
    attempts += 1;

    const searchProfile = buildSearchProfile(
      alternatives.length,
      plan.preferences,
      plan.diversity.alternatePreferenceProfiles,
      baseWeights.isPureSatisfiability
    );

    const buildT0 = performance.now();
    const built = buildCpSatModel(problem, searchProfile.preferences, exclusionCuts);
    modelConstructionMs += performance.now() - buildT0;

    if (built.triviallyInfeasible) {
      if (alternatives.length === 0) {
        firstRunTerminalStatus = 'INFEASIBLE';
      }
      break;
    }

    const solveT0 = performance.now();
    const cpResult = await CpSat.solve(built.model, {
      executor: 'direct',
      numWorkers: 1,
      maxTimeInSeconds,
      ...(options?.randomSeed !== undefined ? { randomSeed: options.randomSeed } : {}),
    });
    solverExecutionMs += performance.now() - solveT0;

    const terminalStatus = mapCpSatStatus(
      typeof cpResult.statusName === 'function'
        ? cpResult.statusName()
        : String(cpResult.status)
    );

    if (terminalStatus === 'INFEASIBLE' || terminalStatus === 'TIMEOUT_ABORT' || !cpResult.hasSolution) {
      if (alternatives.length === 0) {
        firstRunTerminalStatus = terminalStatus;
      }
      break;
    }

    // Extract selected nodes from CP-SAT assignment
    const selectedAllSet = new Set<number>();
    const selectedFlexibleSet = new Set<number>();
    const selectedSectionIds: string[] = [];
    const seenSectionIds = new Set<string>();

    for (const node of problem.nodes) {
      if (cpResult.booleanValue(built.xVars[node.nodeIndex])) {
        selectedAllSet.add(node.nodeIndex);
        if (!node.isPreEnlisted) {
          selectedFlexibleSet.add(node.nodeIndex);
        }
        if (!seenSectionIds.has(node.sectionId)) {
          seenSectionIds.add(node.sectionId);
          selectedSectionIds.push(node.sectionId);
        }
      }
    }

    // Verify Hamming distance against all previously accepted alternatives (excluding pre-enlisted).
    const hammingDistances = acceptedFlexibleSets.map((prevSet) =>
      computeHammingDistance(selectedFlexibleSet, prevSet)
    );
    const passesHamming = hammingDistances.every((d) => d >= minHamming);

    if (!passesHamming) {
      // Discard candidate and initiate a fresh model re-run with updated exclusion cut (SPEC.md Section 5.5).
      exclusionCuts.push({
        nodeIndices: Array.from(selectedFlexibleSet),
        minDiff: effectiveCutMinDiff,
      });
      continue;
    }

    // Evaluate objective score Z against the student's configured base preferences.
    const evaluated = evaluateSelectionObjective(
      problem,
      selectedAllSet,
      plan.preferences
    );

    alternatives.push({
      planLabel: searchProfile.planLabel,
      profileTag: searchProfile.profileTag,
      totalUnits: Number(problem.totalUnits.toFixed(2)),
      status: terminalStatus === 'OPTIMAL' ? 'OPTIMAL' : 'FEASIBLE',
      objectiveScoreZ: evaluated.objectiveScoreZ,
      selectedSectionIds,
      hammingDistanceFromPrev: hammingDistances,
    });

    acceptedFlexibleSets.push(selectedFlexibleSet);

    // If there are no flexible sections (everything is pre-enlisted), no distinct alternative exists.
    if (selectedFlexibleSet.size === 0) {
      break;
    }

    // Accumulate Eq. (16) exclusion cut for subsequent iterations.
    exclusionCuts.push({
      nodeIndices: Array.from(selectedFlexibleSet),
      minDiff: effectiveCutMinDiff,
    });
  }

  const overallStatus: SolverTerminalStatus =
    alternatives.length === 0
      ? firstRunTerminalStatus
      : alternatives.every((alt) => alt.status === 'OPTIMAL')
        ? 'OPTIMAL'
        : 'FEASIBLE';

  // Phase 2: Automatically invoke QuickXplain Conflict Diagnosis on initial INFEASIBLE solve.
  let diagnosis: InfeasibilityDiagnosis | null = null;
  let musExtractionMs: number | undefined;

  if (overallStatus === 'INFEASIBLE' && !options?.skipDiagnosis) {
    const diagResult = await diagnosePreprocessedProblem(plan, problem, diagOptions);
    diagnosis = diagResult.diagnosis;
    musExtractionMs = diagResult.musExtractionMs;
  }

  return {
    status: overallStatus,
    alternatives,
    diagnosis,
    timing: {
      wasmInitMs: coldStartMs,
      modelConstructionMs: Number(modelConstructionMs.toFixed(2)),
      solverExecutionMs: Number(solverExecutionMs.toFixed(2)),
      ...(musExtractionMs !== undefined ? { musExtractionMs } : {}),
    },
  };
}
