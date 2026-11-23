import { CpModel, CpSat, setSingleThreadWarningEnabled } from 'or-tools-wasm/cp-sat';
import type { WorkerSmokeTestRequest, WorkerSmokeTestResponse } from '../types/worker';

setSingleThreadWarningEnabled(false);

let wasmBootstrapped = false;
let cachedInitMs = 0;

async function runSmokeTest(): Promise<WorkerSmokeTestResponse> {
  const t0 = performance.now();

  try {
    const model = new CpModel();
    const x = model.newBoolVar('smoke_x');
    model.addEquality(x, 1);

    const result = await CpSat.solve(model, {
      executor: 'direct',
    });

    const elapsedMs = Number((performance.now() - t0).toFixed(2));
    if (!wasmBootstrapped) {
      wasmBootstrapped = true;
      cachedInitMs = elapsedMs;
    }

    return {
      type: 'SMOKE_TEST_RESULT',
      ok: result.hasSolution,
      wasmInitMs: cachedInitMs,
      smokeSolveStatus: String(result.status),
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

self.addEventListener('message', (event: MessageEvent<WorkerSmokeTestRequest>) => {
  if (event.data?.type === 'SMOKE_TEST') {
    void runSmokeTest().then((response) => {
      self.postMessage(response);
    });
  }
});
