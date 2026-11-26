import { CpSat } from 'or-tools-wasm/cp-sat';
import type { AcademicPlanState } from '../types/domain.ts';
import type {
  FallbackScheduleOption,
  GeneratedScheduleAlternative,
  InfeasibilityDiagnosis,
  RelaxationAction,
} from '../types/solver.ts';
import type { DiagnosisExecutionOptions } from '../types/worker.ts';
import {
  applyRelaxationToPlan,
  buildDataInconsistencyDiagnosis,
  buildExhaustedCapacityDiagnosis,
  buildResourceFallbackDiagnosis,
  mapMusToDiagnosis,
} from './explainer.ts';
import { buildCpSatModel } from './modelBuilder.ts';
import { evaluateSelectionObjective } from './objective.ts';
import {
  preprocessAcademicPlan,
  type PreprocessedProblem,
} from './preprocess.ts';
import {
  buildForegroundConstraints,
  checkSubsetConsistencyPureSat,
  createQuickXplainBudget,
  quickXplain,
  QuickXplainFallbackError,
  type ForegroundConstraintItem,
  type QuickXplainBudget,
} from './quickxplain.ts';
import { ensureWasmInitialized, mapCpSatStatus } from './wasmRuntime.ts';

export const DEFAULT_MAX_FALLBACK_OPTIONS = 3;

export interface DiagnosisRunResult {
  isFeasible: boolean;
  diagnosis: InfeasibilityDiagnosis | null;
  musExtractionMs: number;
  consistencyChecks: number;
  wasmInitMs: number;
}

/**
 * Runs a single fast CP-SAT solve on a relaxed plan to verify whether relaxing a specific
 * MUS constraint yields a feasible/optimal fallback schedule.
 */
async function solveFallbackCandidate(
  relaxedPlan: AcademicPlanState,
  action: RelaxationAction,
  budget: QuickXplainBudget,
  unitLimits: DiagnosisExecutionOptions['unitLimits'],
  fallbackIndex: number,
  includeFullSections?: boolean
): Promise<FallbackScheduleOption | null> {
  const remainingSec = (budget.deadlineMs - performance.now()) / 1000;
  if (remainingSec < 0.08) {
    return null;
  }

  const relaxedProblem = preprocessAcademicPlan(relaxedPlan, unitLimits, {
    includeFullSections,
  });
  if (relaxedProblem.exhaustedCourses.length > 0) {
    return null;
  }

  // Handle empty relaxed plan cleanly (e.g. dropping the only intended course)
  if (relaxedProblem.courses.length === 0) {
    const minUnits = relaxedProblem.unitLimits?.minUnits ?? 0;
    if (minUnits > 0) {
      return null;
    }
    return {
      relaxation: action,
      schedule: {
        planLabel: `Fallback ${fallbackIndex + 1}`,
        profileTag: 'Relaxed',
        totalUnits: 0,
        status: 'OPTIMAL',
        objectiveScoreZ: 0,
        selectedSectionIds: [],
        hammingDistanceFromPrev: [],
      },
    };
  }

  const built = buildCpSatModel(relaxedProblem, relaxedPlan.preferences);
  if (built.triviallyInfeasible) {
    return null;
  }

  const timeLimit = Math.min(budget.probeTimeLimitSeconds, remainingSec);
  const cpResult = await CpSat.solve(built.model, {
    executor: 'direct',
    numWorkers: 1,
    maxTimeInSeconds: timeLimit,
    ...(budget.randomSeed !== undefined ? { randomSeed: budget.randomSeed } : {}),
  });

  const terminalStatus = mapCpSatStatus(
    typeof cpResult.statusName === 'function'
      ? cpResult.statusName()
      : String(cpResult.status)
  );

  if (
    (terminalStatus !== 'OPTIMAL' && terminalStatus !== 'FEASIBLE') ||
    !cpResult.hasSolution
  ) {
    return null;
  }

  const selectedAllSet = new Set<number>();
  const selectedSectionIds: string[] = [];
  const seenSectionIds = new Set<string>();

  for (const node of relaxedProblem.nodes) {
    if (cpResult.booleanValue(built.xVars[node.nodeIndex])) {
      selectedAllSet.add(node.nodeIndex);
      if (!seenSectionIds.has(node.sectionId)) {
        seenSectionIds.add(node.sectionId);
        selectedSectionIds.push(node.sectionId);
      }
    }
  }

  const evaluated = evaluateSelectionObjective(
    relaxedProblem,
    selectedAllSet,
    relaxedPlan.preferences
  );

  const schedule: GeneratedScheduleAlternative = {
    planLabel: `Fallback ${fallbackIndex + 1}`,
    profileTag: 'Relaxed',
    totalUnits: Number(relaxedProblem.totalUnits.toFixed(2)),
    status: terminalStatus,
    objectiveScoreZ: evaluated.objectiveScoreZ,
    selectedSectionIds,
    hammingDistanceFromPrev: [],
  };

  return {
    relaxation: action,
    schedule,
  };
}

async function computeFallbackScheduleOptions(
  plan: AcademicPlanState,
  diagnosis: InfeasibilityDiagnosis,
  budget: QuickXplainBudget,
  options?: DiagnosisExecutionOptions
): Promise<FallbackScheduleOption[]> {
  if (options?.includeFallbackOptions === false) {
    return [];
  }
  const actions = diagnosis.relaxationActions ?? [];
  if (actions.length === 0) {
    return [];
  }

  const maxFallbacks = Math.max(
    0,
    Math.min(6, Math.floor(options?.maxFallbackOptions ?? DEFAULT_MAX_FALLBACK_OPTIONS))
  );
  if (maxFallbacks === 0) {
    return [];
  }

  const fallbacks: FallbackScheduleOption[] = [];
  for (const action of actions) {
    if (fallbacks.length >= maxFallbacks) {
      break;
    }
    try {
      const relaxedPlan = applyRelaxationToPlan(plan, action);
      const option = await solveFallbackCandidate(
        relaxedPlan,
        action,
        budget,
        options?.unitLimits,
        fallbacks.length,
        options?.includeFullSections
      );
      if (option) {
        fallbacks.push(option);
      }
    } catch {
      // Fallback schedule generation is best-effort; never abort a completed MUS diagnosis.
      break;
    }
  }

  return fallbacks;
}

/**
 * Executes the complete 3-tier Phase 2 Conflict Diagnosis workflow (SPEC.md Section 6.2–6.4)
 * on an already-preprocessed academic plan problem:
 * - Tier 1: Background Set B consistency check (Pure SAT) -> DATA_INCONSISTENCY
 * - Tier 2: Exhausted Capacity check -> EXHAUSTED_CAPACITY
 * - Tier 3: Priority-sorted Foreground Set C recursive QuickXplain -> PREFERENCE_CONFLICT
 *           (with deterministic natural-language mapping and verified fallback schedule options)
 * - Guard: Catches WASM memory/timeout aborts -> SOLVER_RESOURCE_FALLBACK
 */
export async function diagnosePreprocessedProblem(
  plan: AcademicPlanState,
  problem: PreprocessedProblem,
  options?: DiagnosisExecutionOptions
): Promise<Omit<DiagnosisRunResult, 'wasmInitMs'>> {
  const t0 = performance.now();
  const budget = createQuickXplainBudget(options);

  // Tier 1 / Tier 2 Ordering:
  // If any course has exhausted capacity, check whether Background Set B itself has structural
  // inconsistencies (pre-enlisted overlaps or impossible unit bounds) before flagging EXHAUSTED_CAPACITY.
  if (problem.exhaustedCourses.length > 0) {
    const hasBackgroundRisk =
      plan.preEnlistedCourses.length > 0 || problem.unitLimits !== null;

    if (hasBackgroundRisk) {
      try {
        const bgConsistent = await checkSubsetConsistencyPureSat(problem, [], budget);
        budget.consistencyChecks += 1;
        if (!bgConsistent) {
          return {
            isFeasible: false,
            diagnosis: buildDataInconsistencyDiagnosis(problem),
            musExtractionMs: Number((performance.now() - t0).toFixed(2)),
            consistencyChecks: budget.consistencyChecks,
          };
        }
      } catch (err) {
        if (err instanceof QuickXplainFallbackError) {
          return {
            isFeasible: false,
            diagnosis: buildResourceFallbackDiagnosis(),
            musExtractionMs: Number((performance.now() - t0).toFixed(2)),
            consistencyChecks: budget.consistencyChecks,
          };
        }
        throw err;
      }
    }

    return {
      isFeasible: false,
      diagnosis: buildExhaustedCapacityDiagnosis(problem),
      musExtractionMs: Number((performance.now() - t0).toFixed(2)),
      consistencyChecks: budget.consistencyChecks,
    };
  }

  const foregroundItems = buildForegroundConstraints(problem, plan, options);

  try {
    const qxResult = await quickXplain<ForegroundConstraintItem>(
      [],
      foregroundItems,
      (activeSubset, activeBudget) =>
        checkSubsetConsistencyPureSat(problem, activeSubset, activeBudget),
      budget,
      (item) => item.key
    );

    if (qxResult.status === 'CONSISTENT') {
      return {
        isFeasible: true,
        diagnosis: null,
        musExtractionMs: Number((performance.now() - t0).toFixed(2)),
        consistencyChecks: qxResult.consistencyChecks,
      };
    }

    if (qxResult.status === 'BACKGROUND_INCONSISTENT') {
      return {
        isFeasible: false,
        diagnosis: buildDataInconsistencyDiagnosis(problem),
        musExtractionMs: Number((performance.now() - t0).toFixed(2)),
        consistencyChecks: qxResult.consistencyChecks,
      };
    }

    const musRefs = qxResult.mus.map((item) => item.ref);
    const diagnosis = mapMusToDiagnosis(problem, musRefs);

    const fallbackOptions = await computeFallbackScheduleOptions(
      plan,
      diagnosis,
      budget,
      options
    );
    diagnosis.fallbackOptions = fallbackOptions;

    return {
      isFeasible: false,
      diagnosis,
      musExtractionMs: Number((performance.now() - t0).toFixed(2)),
      consistencyChecks: qxResult.consistencyChecks,
    };
  } catch (err) {
    if (err instanceof QuickXplainFallbackError) {
      return {
        isFeasible: false,
        diagnosis: buildResourceFallbackDiagnosis(),
        musExtractionMs: Number((performance.now() - t0).toFixed(2)),
        consistencyChecks: budget.consistencyChecks,
      };
    }
    // Defensive guard for unexpected WASM runtime/memory errors inside the worker
    return {
      isFeasible: false,
      diagnosis: buildResourceFallbackDiagnosis(),
      musExtractionMs: Number((performance.now() - t0).toFixed(2)),
      consistencyChecks: budget.consistencyChecks,
    };
  }
}

/**
 * Standalone entry point for explicit conflict diagnosis requests (e.g., Web Worker
 * `DIAGNOSE_CONFLICTS` message or direct programmatic diagnosis).
 */
export async function diagnoseAcademicPlan(
  plan: AcademicPlanState,
  options?: DiagnosisExecutionOptions
): Promise<DiagnosisRunResult> {
  const { coldStartMs } = await ensureWasmInitialized();
  const problem = preprocessAcademicPlan(plan, options?.unitLimits, {
    includeFullSections: options?.includeFullSections,
  });
  const result = await diagnosePreprocessedProblem(plan, problem, options);
  return {
    ...result,
    wasmInitMs: coldStartMs,
  };
}
