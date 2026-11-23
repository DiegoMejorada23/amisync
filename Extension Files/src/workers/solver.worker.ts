import {
  CpModel,
  CpSat,
  setCloudNoticeEnabled,
  setSingleThreadWarningEnabled,
} from 'or-tools-wasm/cp-sat';
import { diagnoseAcademicPlan } from '../solver/diagnosis.ts';
import {
  ensureWasmInitialized,
  getCachedWasmInitMs,
  solveAcademicPlan,
} from '../solver/engine.ts';
import type {
  SolverWorkerRequest,
  SolverWorkerResponse,
  WorkerDiagnoseRequest,
  WorkerDiagnoseResponse,
  WorkerSmokeTestResponse,
  WorkerSolveRequest,
  WorkerSolveResponse,
} from '../types/worker.ts';

setSingleThreadWarningEnabled(false);
setCloudNoticeEnabled(false);

async function runSmokeTest(): Promise<WorkerSmokeTestResponse> {
  const t0 = performance.now();

  try {
    await ensureWasmInitialized();

    const model = new CpModel();
    const x = model.newBoolVar('smoke_x');
    model.addEquality(x, 1);

    const result = await CpSat.solve(model, {
      executor: 'direct',
      numWorkers: 1,
      maxTimeInSeconds: 5.0,
    });

    const wasmInitMs = getCachedWasmInitMs() || Number((performance.now() - t0).toFixed(2));

    return {
      type: 'SMOKE_TEST_RESULT',
      ok: result.hasSolution,
      wasmInitMs,
      smokeSolveStatus: result.statusName(),
      variableValue: result.hasSolution ? Number(result.value(x)) : undefined,
    };
  } catch (err) {
    const elapsedMs = Number((performance.now() - t0).toFixed(2));
    return {
      type: 'SMOKE_TEST_RESULT',
      ok: false,
      wasmInitMs: elapsedMs,
      smokeSolveStatus: 'ERROR',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runSolveRequest(request: WorkerSolveRequest): Promise<WorkerSolveResponse> {
  try {
    const payload = await solveAcademicPlan(request.plan, request.options);
    return {
      type: 'SOLVE_SCHEDULE_RESULT',
      requestId: request.requestId,
      ok: true,
      payload,
    };
  } catch (err) {
    return {
      type: 'SOLVE_SCHEDULE_RESULT',
      requestId: request.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runDiagnoseRequest(
  request: WorkerDiagnoseRequest
): Promise<WorkerDiagnoseResponse> {
  try {
    const result = await diagnoseAcademicPlan(request.plan, request.options);
    return {
      type: 'DIAGNOSE_CONFLICTS_RESULT',
      requestId: request.requestId,
      ok: true,
      isFeasible: result.isFeasible,
      diagnosis: result.diagnosis,
      timing: {
        wasmInitMs: result.wasmInitMs,
        modelConstructionMs: 0,
        solverExecutionMs: 0,
        musExtractionMs: result.musExtractionMs,
      },
    };
  } catch (err) {
    return {
      type: 'DIAGNOSE_CONFLICTS_RESULT',
      requestId: request.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Typed Web Worker message dispatcher supporting:
 * - MV3 WASM smoke test (`SMOKE_TEST`)
 * - Phase 1 CP-SAT schedule optimization with automatic Phase 2 QuickXplain on INFEASIBLE (`SOLVE_SCHEDULE`)
 * - Explicit Phase 2 QuickXplain conflict diagnosis (`DIAGNOSE_CONFLICTS`)
 */
export async function handleWorkerRequest(
  request: SolverWorkerRequest
): Promise<SolverWorkerResponse | null> {
  if (!request || typeof request !== 'object') {
    return null;
  }

  switch (request.type) {
    case 'SMOKE_TEST':
      return runSmokeTest();
    case 'SOLVE_SCHEDULE':
      return runSolveRequest(request);
    case 'DIAGNOSE_CONFLICTS':
      return runDiagnoseRequest(request);
    default:
      return null;
  }
}

// Register listener only when executing inside a Web Worker global scope.
if (
  typeof self !== 'undefined' &&
  typeof self.addEventListener === 'function' &&
  typeof self.postMessage === 'function'
) {
  self.addEventListener('message', (event: MessageEvent<SolverWorkerRequest>) => {
    void handleWorkerRequest(event.data).then((response) => {
      if (response) {
        self.postMessage(response);
      }
    });
  });
}
