import type { AcademicPlanState, UnitLimitsConfig } from './domain.ts';
import type { SolverResponsePayload } from './solver.ts';

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

export interface SolverExecutionOptions {
  /** Per-solve heuristic time limit in seconds (defaults to 10.0s per SPEC.md Section 5.6). */
  maxTimeInSeconds?: number;
  /** Optional unit bounds overriding or augmenting AcademicPlanState.unitLimits. */
  unitLimits?: UnitLimitsConfig;
  /** Optional deterministic random seed for reproducible testing. */
  randomSeed?: number;
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

export type SolverWorkerRequest = WorkerSmokeTestRequest | WorkerSolveRequest;
export type SolverWorkerResponse = WorkerSmokeTestResponse | WorkerSolveResponse;
