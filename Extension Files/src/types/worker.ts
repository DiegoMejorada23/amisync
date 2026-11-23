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
