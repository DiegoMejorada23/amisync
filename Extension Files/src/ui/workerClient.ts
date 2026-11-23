import type { AcademicPlanState } from '../types/domain.ts';
import type {
  InfeasibilityDiagnosis,
  SolverResponsePayload,
} from '../types/solver.ts';
import type {
  DiagnosisExecutionOptions,
  SolverExecutionOptions,
  SolverWorkerRequest,
  SolverWorkerResponse,
  WorkerSmokeTestResponse,
} from '../types/worker.ts';

const WORKER_SOLVE_TIMEOUT_MS = 35_000;

export class SolverCancelledError extends Error {
  readonly isCancelled = true;

  constructor(message = 'Solver operation cancelled.') {
    super(message);
    this.name = 'SolverCancelledError';
  }
}

export function isSolverCancelledError(err: unknown): err is SolverCancelledError {
  return (
    err instanceof SolverCancelledError ||
    (typeof err === 'object' &&
      err !== null &&
      'isCancelled' in err &&
      (err as { isCancelled?: unknown }).isCancelled === true)
  );
}

export interface SolverWorkerClientOptions {
  workerFactory?: () => Worker;
  timeoutMs?: number;
}

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Promise-based client managing the dedicated `solver.worker.ts` Web Worker.
 * Cancels superseded in-flight solves immediately and ignores stale responses via `requestId`.
 */
export class SolverWorkerClient {
  private worker: Worker | null = null;
  private disposed = false;
  private readonly workerFactory: () => Worker;
  private readonly timeoutMs: number;
  private smokeWaiters: Array<PendingRequest<WorkerSmokeTestResponse>> = [];
  private solveWaiters = new Map<string, PendingRequest<SolverResponsePayload>>();
  private diagnoseWaiters = new Map<
    string,
    PendingRequest<{ isFeasible: boolean; diagnosis: InfeasibilityDiagnosis | null }>
  >();

  constructor(options?: SolverWorkerClientOptions) {
    this.workerFactory =
      options?.workerFactory ??
      (() =>
        new Worker(new URL('../workers/solver.worker.ts', import.meta.url), {
          type: 'module',
        }));
    this.timeoutMs = options?.timeoutMs ?? WORKER_SOLVE_TIMEOUT_MS;
  }

  private ensureWorker(): Worker {
    if (this.disposed) {
      throw new Error('SolverWorkerClient has been disposed.');
    }
    if (this.worker) {
      return this.worker;
    }

    const worker = this.workerFactory();

    worker.onmessage = (event: MessageEvent<SolverWorkerResponse>) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') {
        return;
      }

      if (msg.type === 'SMOKE_TEST_RESULT') {
        const waiter = this.smokeWaiters.shift();
        if (waiter) {
          clearTimeout(waiter.timeoutId);
          waiter.resolve(msg);
        }
        return;
      }

      if (msg.type === 'SOLVE_SCHEDULE_RESULT') {
        const waiter = this.solveWaiters.get(msg.requestId);
        if (!waiter) return;
        this.solveWaiters.delete(msg.requestId);
        clearTimeout(waiter.timeoutId);
        if (msg.ok && msg.payload) {
          waiter.resolve(msg.payload);
        } else {
          waiter.reject(new Error(msg.error ?? 'Solver worker failed to solve schedule.'));
        }
        return;
      }

      if (msg.type === 'DIAGNOSE_CONFLICTS_RESULT') {
        const waiter = this.diagnoseWaiters.get(msg.requestId);
        if (!waiter) return;
        this.diagnoseWaiters.delete(msg.requestId);
        clearTimeout(waiter.timeoutId);
        if (msg.ok) {
          waiter.resolve({
            isFeasible: Boolean(msg.isFeasible),
            diagnosis: msg.diagnosis ?? null,
          });
        } else {
          waiter.reject(new Error(msg.error ?? 'Solver worker failed to diagnose conflicts.'));
        }
      }
    };

    worker.onerror = (err: ErrorEvent) => {
      const failure = new Error(err.message || 'CP-SAT Web Worker crashed unexpectedly.');
      this.rejectAllPending(failure);
      this.terminateWorkerInstance();
    };

    this.worker = worker;
    return worker;
  }

  private terminateWorkerInstance(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  private rejectAllPending(error: Error): void {
    while (this.smokeWaiters.length > 0) {
      const w = this.smokeWaiters.shift();
      if (w) {
        clearTimeout(w.timeoutId);
        w.reject(error);
      }
    }
    for (const [id, waiter] of this.solveWaiters.entries()) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(error);
      this.solveWaiters.delete(id);
    }
    for (const [id, waiter] of this.diagnoseWaiters.entries()) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(error);
      this.diagnoseWaiters.delete(id);
    }
  }

  /**
   * Terminates any in-flight solve/diagnosis run immediately without disposing the client.
   */
  cancelInFlight(reason = 'Solver operation cancelled.'): void {
    if (this.solveWaiters.size === 0 && this.diagnoseWaiters.size === 0 && this.smokeWaiters.length === 0) {
      return;
    }
    this.rejectAllPending(new SolverCancelledError(reason));
    this.terminateWorkerInstance();
  }

  /**
   * Warms up `or-tools-wasm` inside the Web Worker ahead of the first user solve.
   */
  warmup(): Promise<WorkerSmokeTestResponse> {
    const worker = this.ensureWorker();
    return new Promise<WorkerSmokeTestResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = this.smokeWaiters.findIndex((w) => w.timeoutId === timeoutId);
        if (idx !== -1) {
          this.smokeWaiters.splice(idx, 1);
        }
        reject(new Error('WASM worker warmup timed out.'));
      }, this.timeoutMs);

      this.smokeWaiters.push({ resolve, reject, timeoutId });
      const req: SolverWorkerRequest = { type: 'SMOKE_TEST' };
      worker.postMessage(req);
    });
  }

  /**
   * Executes Phase 1 CP-SAT optimization (and automatic Phase 2 QuickXplain on INFEASIBLE).
   * Cancels and terminates any superseded in-flight solve/diagnosis run before starting.
   */
  solve(plan: AcademicPlanState, options?: SolverExecutionOptions): Promise<SolverResponsePayload> {
    if (this.disposed) {
      return Promise.reject(new Error('SolverWorkerClient has been disposed.'));
    }
    if (this.solveWaiters.size > 0 || this.diagnoseWaiters.size > 0) {
      this.cancelInFlight('Superseded by a newer solve request.');
    }

    const worker = this.ensureWorker();
    const requestId = crypto.randomUUID();

    return new Promise<SolverResponsePayload>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.solveWaiters.delete(requestId);
        this.terminateWorkerInstance();
        reject(new Error('Optimization exceeded client safety timeout and the worker was reset.'));
      }, this.timeoutMs);

      this.solveWaiters.set(requestId, { resolve, reject, timeoutId });
      const req: SolverWorkerRequest = {
        type: 'SOLVE_SCHEDULE',
        requestId,
        plan,
        options,
      };
      worker.postMessage(req);
    });
  }

  /**
   * Explicitly invokes Phase 2 QuickXplain conflict diagnosis.
   * Cancels and terminates any superseded in-flight solve/diagnosis run before starting.
   */
  diagnose(
    plan: AcademicPlanState,
    options?: DiagnosisExecutionOptions
  ): Promise<{ isFeasible: boolean; diagnosis: InfeasibilityDiagnosis | null }> {
    if (this.disposed) {
      return Promise.reject(new Error('SolverWorkerClient has been disposed.'));
    }
    if (this.solveWaiters.size > 0 || this.diagnoseWaiters.size > 0) {
      this.cancelInFlight('Superseded by a newer diagnosis request.');
    }

    const worker = this.ensureWorker();
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.diagnoseWaiters.delete(requestId);
        this.terminateWorkerInstance();
        reject(new Error('Conflict diagnosis exceeded client safety timeout.'));
      }, this.timeoutMs);

      this.diagnoseWaiters.set(requestId, { resolve, reject, timeoutId });
      const req: SolverWorkerRequest = {
        type: 'DIAGNOSE_CONFLICTS',
        requestId,
        plan,
        options,
      };
      worker.postMessage(req);
    });
  }

  /**
   * Terminates any in-flight WASM run immediately and prepares a fresh worker for subsequent requests.
   */
  cancelAndRespawn(): void {
    this.cancelInFlight('Solver operation cancelled by user.');
    this.terminateWorkerInstance();
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAllPending(new SolverCancelledError('SolverWorkerClient disposed.'));
    this.terminateWorkerInstance();
  }
}
