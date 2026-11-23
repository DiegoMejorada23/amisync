import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkerSmokeTestResponse } from './types/worker';

type SmokeState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ready'; result: WorkerSmokeTestResponse }
  | { status: 'error'; message: string };

export default function App() {
  const workerRef = useRef<Worker | null>(null);
  const [smokeState, setSmokeState] = useState<SmokeState>({ status: 'idle' });

  const handleDismiss = useCallback(() => {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'AMISYNC_DISMISS_OVERLAY' }, '*');
    } else {
      window.close();
    }
  }, []);

  const runWorkerSmokeTest = useCallback(() => {
    setSmokeState({ status: 'running' });

    try {
      workerRef.current?.terminate();
      const worker = new Worker(new URL('./workers/solver.worker.ts', import.meta.url), {
        type: 'module',
      });
      workerRef.current = worker;

      worker.onmessage = (event: MessageEvent<WorkerSmokeTestResponse>) => {
        if (event.data?.type === 'SMOKE_TEST_RESULT') {
          if (event.data.ok) {
            setSmokeState({ status: 'ready', result: event.data });
          } else {
            setSmokeState({
              status: 'error',
              message: event.data.error ?? `Unexpected solver status: ${event.data.smokeSolveStatus}`,
            });
          }
        }
      };

      worker.onerror = (err) => {
        setSmokeState({
          status: 'error',
          message: err.message || 'Web Worker failed to initialize.',
        });
      };

      worker.postMessage({ type: 'SMOKE_TEST' });
    } catch (err) {
      setSmokeState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    runWorkerSmokeTest();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [runWorkerSmokeTest]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleDismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleDismiss]);

  return (
    <div className="app-shell">
      <header className="top-bar">
        <h1 className="top-bar__title">SCHEDULE OPTIMIZER</h1>
        <button
          type="button"
          className="top-bar__close"
          aria-label="Close Schedule Optimizer"
          onClick={handleDismiss}
        >
          &times;
        </button>
      </header>

      <main className="workspace-scaffold">
        <section className="scaffold-card">
          <div className="scaffold-card__header">
            <span className="scaffold-badge">MILESTONE 1</span>
            <h2>Manifest V3 &amp; OR-Tools WASM Worker Verification</h2>
          </div>

          <p className="scaffold-card__desc">
            Verifying strict MV3 Content Security Policy (<code>&apos;wasm-unsafe-eval&apos;</code>),
            ES module Web Worker compilation, and client-side CP-SAT initialization.
          </p>

          <div className="smoke-panel">
            <div className="smoke-row">
              <span className="smoke-label">Solver Worker Status</span>
              <span className={`smoke-value smoke-value--${smokeState.status}`}>
                {smokeState.status === 'idle' && 'Idle'}
                {smokeState.status === 'running' && 'Initializing or-tools-wasm...'}
                {smokeState.status === 'ready' && `Ready (${smokeState.result.smokeSolveStatus})`}
                {smokeState.status === 'error' && 'Failed'}
              </span>
            </div>

            {smokeState.status === 'ready' && (
              <>
                <div className="smoke-row">
                  <span className="smoke-label">wasmInitMs</span>
                  <span className="smoke-value">{smokeState.result.wasmInitMs.toFixed(2)} ms</span>
                </div>
                <div className="smoke-row">
                  <span className="smoke-label">Smoke Variable Assignment</span>
                  <span className="smoke-value">
                    smoke_x = {String(smokeState.result.variableValue ?? 'N/A')}
                  </span>
                </div>
              </>
            )}

            {smokeState.status === 'error' && (
              <div className="smoke-error">{smokeState.message}</div>
            )}
          </div>

          <div className="scaffold-actions">
            <button type="button" className="btn-primary" onClick={runWorkerSmokeTest}>
              Re-run WASM Worker Smoke Test
            </button>
          </div>
        </section>
      </main>

      <footer className="bottom-strip">
        <span>Press [Esc] to dismiss</span>
      </footer>
    </div>
  );
}
