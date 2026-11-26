import type { AcademicPlanState, UnitLimitsConfig } from './domain.ts';
import type {
  InfeasibilityDiagnosis,
  SolverResponsePayload,
  SolverTimingProfile,
} from './solver.ts';

export interface WorkerSmokeTestRequest {
  type: 'SMOKE_TEST';
}

export interface WorkerSmokeTestResponse {
  type: 'SMOKE_TEST_RESULT';
  ok: boolean;
  wasmInitMs: number;
  smokeSolveStatus: string;
  variableValue?: number;
  error?: string;
}

export interface DiagnosisExecutionOptions {
  /** Total wall-clock budget for QuickXplain diagnosis in seconds (defaults to 5.0s). */
  maxTimeInSeconds?: number;
  /** Per-probe CP-SAT consistency check time limit in seconds (defaults to 2.0s). */
  probeTimeLimitSeconds?: number;
  /** Maximum recursive consistency checks before triggering resource fallback (defaults to 256). */
  maxConsistencyChecks?: number;
  /** Optional unit bounds overriding or augmenting AcademicPlanState.unitLimits. */
  unitLimits?: UnitLimitsConfig;
  /** Optional override to include full/closed sections (0 open slots) as valid candidates. */
  includeFullSections?: boolean;
  /**
   * Optional priority overrides for foreground constraints, keyed by constraint key
   * (e.g., courseId, courseCode, blockId, or sectionId). Higher values = preserved first.
   */
  constraintPriorities?: Record<string, number>;
  /** Whether to compute verified feasible fallback schedules by relaxing MUS constraints (defaults to true). */
  includeFallbackOptions?: boolean;
  /** Maximum number of fallback schedule options to compute (defaults to 3). */
  maxFallbackOptions?: number;
  /** Optional deterministic random seed for reproducible testing. */
  randomSeed?: number;
}

export interface SolverExecutionOptions {
  /** Per-solve heuristic time limit in seconds (defaults to 10.0s per SPEC.md Section 5.6). */
  maxTimeInSeconds?: number;
  /** Optional unit bounds overriding or augmenting AcademicPlanState.unitLimits. */
  unitLimits?: UnitLimitsConfig;
  /** Optional override to include full/closed sections (0 open slots) as valid candidates. */
  includeFullSections?: boolean;
  /** Optional deterministic random seed for reproducible testing. */
  randomSeed?: number;
  /** Configuration for automatic Phase 2 QuickXplain diagnosis on INFEASIBLE solves. */
  diagnosis?: DiagnosisExecutionOptions;
  /** Set true to skip automatic QuickXplain diagnosis when Phase 1 is INFEASIBLE. */
  skipDiagnosis?: boolean;
}

export interface WorkerSolveRequest {
  type: 'SOLVE_SCHEDULE';
  requestId: string;
  plan: AcademicPlanState;
  options?: SolverExecutionOptions;
}

export interface WorkerSolveResponse {
  type: 'SOLVE_SCHEDULE_RESULT';
  requestId: string;
  ok: boolean;
  payload?: SolverResponsePayload;
  error?: string;
}

export interface WorkerDiagnoseRequest {
  type: 'DIAGNOSE_CONFLICTS';
  requestId: string;
  plan: AcademicPlanState;
  options?: DiagnosisExecutionOptions;
}

export interface WorkerDiagnoseResponse {
  type: 'DIAGNOSE_CONFLICTS_RESULT';
  requestId: string;
  ok: boolean;
  isFeasible?: boolean;
  diagnosis?: InfeasibilityDiagnosis | null;
  timing?: SolverTimingProfile;
  error?: string;
}

export type SolverWorkerRequest =
  | WorkerSmokeTestRequest
  | WorkerSolveRequest
  | WorkerDiagnoseRequest;

export type SolverWorkerResponse =
  | WorkerSmokeTestResponse
  | WorkerSolveResponse
  | WorkerDiagnoseResponse;
