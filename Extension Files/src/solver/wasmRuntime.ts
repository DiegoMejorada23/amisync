import {
  CpModel,
  CpSat,
  setCloudNoticeEnabled,
  setSingleThreadWarningEnabled,
} from 'or-tools-wasm/cp-sat';
import type { SolverTerminalStatus } from '../types/solver.ts';

setSingleThreadWarningEnabled(false);
setCloudNoticeEnabled(false);

let wasmInitialized = false;
let cachedWasmInitMs = 0;

/**
 * Bootstraps the or-tools-wasm CP-SAT runtime once and profiles cold-start initialization
 * time independently from optimization and diagnosis runs (SPEC.md Section 5.6).
 */
export async function ensureWasmInitialized(): Promise<{
  coldStartMs: number;
  cachedInitMs: number;
}> {
  if (wasmInitialized) {
    return { coldStartMs: 0, cachedInitMs: cachedWasmInitMs };
  }

  const t0 = performance.now();
  const warmup = new CpModel();
  const b = warmup.newBoolVar('wasm_warmup');
  warmup.addEquality(b, 1);
  await CpSat.solve(warmup, {
    executor: 'direct',
    numWorkers: 1,
    maxTimeInSeconds: 5.0,
  });
  const elapsed = Number((performance.now() - t0).toFixed(2));
  wasmInitialized = true;
  cachedWasmInitMs = elapsed;
  return { coldStartMs: elapsed, cachedInitMs: cachedWasmInitMs };
}

export function getCachedWasmInitMs(): number {
  return cachedWasmInitMs;
}

export function mapCpSatStatus(rawStatusName: string): SolverTerminalStatus {
  const upper = rawStatusName.toUpperCase();
  if (upper === 'OPTIMAL' || upper === '4') return 'OPTIMAL';
  if (upper === 'FEASIBLE' || upper === '2') return 'FEASIBLE';
  if (upper === 'INFEASIBLE' || upper === '3') return 'INFEASIBLE';
  return 'TIMEOUT_ABORT';
}
