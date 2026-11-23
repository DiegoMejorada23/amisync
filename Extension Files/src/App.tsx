import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchActiveTermId,
  fetchAuthUserId,
  fetchCourseWithClasses,
  fetchStudentEnlistments,
  getActiveAmisTab,
  getAuthToken,
  isAmisError,
  searchCoursesByCode,
  subscribeAuthTokenSync,
} from './amis/index.ts';
import {
  CoursesTab,
  type AmisConnectionStatus,
} from './components/CoursesTab.tsx';
import { LeftFooterStrip } from './components/LeftFooterStrip.tsx';
import { PlanBar } from './components/PlanBar.tsx';
import { PreferencesTab } from './components/PreferencesTab.tsx';
import { ScheduleConflictsPanel } from './components/ScheduleConflictsPanel.tsx';
import { TimetableGrid } from './components/TimetableGrid.tsx';
import { TopBar } from './components/TopBar.tsx';
import {
  canManualRefresh,
  loadAcademicPlan,
  saveAcademicPlan,
  shouldAutoRefresh,
  subscribeAcademicPlanChanges,
} from './storage/planStorage.ts';
import type { RawAmisCourse } from './types/amis.ts';
import {
  createDefaultAcademicPlanState,
  type AcademicPlanState,
  type StudentPreferences,
  type Weekday,
} from './types/domain.ts';
import type {
  GeneratedScheduleAlternative,
  InfeasibilityDiagnosis,
  RelaxationAction,
} from './types/solver.ts';
import {
  addOrUpdateIntendedCourse,
  applyRelaxationActionToPlan,
  reconcileSyncedPlan,
  removeIntendedCourse,
  toggleBlockedCell,
  toggleCourseAccordion,
  toggleSectionFlag,
  updatePreferences,
  type SyncedCourseRefreshOutcome,
} from './ui/planActions.ts';
import { computePlanUnits } from './ui/scheduleView.ts';
import { isSolverCancelledError, SolverWorkerClient } from './ui/workerClient.ts';

type RightTab = 'courses' | 'preferences';

function hasChromeTabsApi(): boolean {
  const g = globalThis as { chrome?: { tabs?: { query?: unknown }; scripting?: { executeScript?: unknown } } };
  return Boolean(g.chrome?.tabs?.query && g.chrome?.scripting?.executeScript);
}

function hasChromeStorageApi(): boolean {
  const g = globalThis as { chrome?: { storage?: { local?: unknown } } };
  return Boolean(g.chrome?.storage?.local);
}

function formatAmisErrorMessage(err: unknown): string {
  if (isAmisError(err)) {
    return err.message;
  }
  return err instanceof Error ? err.message : 'An unexpected AMIS error occurred.';
}

export default function App() {
  const [plan, setPlan] = useState<AcademicPlanState>(() => createDefaultAcademicPlanState());
  const [storageHydrated, setStorageHydrated] = useState(false);

  const [activeTab, setActiveTab] = useState<RightTab>('courses');
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AmisConnectionStatus>('checking');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [isSyncing, setIsSyncing] = useState(false);
  const [isAddingCourse, setIsAddingCourse] = useState(false);
  const [isSolving, setIsSolving] = useState(false);
  const [isOffline, setIsOffline] = useState(
    () => typeof navigator !== 'undefined' && navigator.onLine === false
  );

  const [alternatives, setAlternatives] = useState<GeneratedScheduleAlternative[]>([]);
  const [selectedPlanIndex, setSelectedPlanIndex] = useState(0);
  const [diagnosis, setDiagnosis] = useState<InfeasibilityDiagnosis | null>(null);
  const [isSolveBlocked, setIsSolveBlocked] = useState(false);

  const workerClientRef = useRef<SolverWorkerClient | null>(null);
  const planRef = useRef<AcademicPlanState>(plan);
  planRef.current = plan;
  const autoSyncedTokenRef = useRef<string | null>(null);
  const solveRunIdRef = useRef(0);
  const activeSolveRef = useRef(false);
  const lastPersistedJsonRef = useRef<string | null>(null);

  const isInIframe = typeof window !== 'undefined' && window.parent !== window;

  // Track browser online/offline transitions gracefully.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // 1. Hydrate AcademicPlanState from chrome.storage.local on mount & sync external updates.
  useEffect(() => {
    let cancelled = false;
    if (!hasChromeStorageApi()) {
      setStorageHydrated(true);
      return;
    }

    void loadAcademicPlan()
      .then((loaded) => {
        if (!cancelled) {
          lastPersistedJsonRef.current = JSON.stringify(loaded);
          planRef.current = loaded;
          setPlan(loaded);
          setStorageHydrated(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStorageHydrated(true);
        }
      });

    const unsubscribeStorage = subscribeAcademicPlanChanges((externalPlan) => {
      if (cancelled) return;
      const serialized = JSON.stringify(externalPlan);
      if (serialized === lastPersistedJsonRef.current) {
        return;
      }
      lastPersistedJsonRef.current = serialized;
      planRef.current = externalPlan;
      setPlan(externalPlan);
      setAlternatives([]);
      setSelectedPlanIndex(0);
      setDiagnosis(null);
      setIsSolveBlocked(false);
    });

    return () => {
      cancelled = true;
      unsubscribeStorage();
    };
  }, []);

  // Persist plan updates cleanly to chrome.storage.local after hydration.
  const commitPlan = useCallback(
    (
      updater: (prev: AcademicPlanState) => AcademicPlanState,
      options?: { resetInfeasibleBlock?: boolean; preserveSchedule?: boolean }
    ): AcademicPlanState => {
      const next = updater(planRef.current);
      planRef.current = next;
      setPlan(next);

      if (options?.preserveSchedule !== true) {
        setAlternatives([]);
        setSelectedPlanIndex(0);
        if (activeSolveRef.current) {
          solveRunIdRef.current += 1;
          activeSolveRef.current = false;
          workerClientRef.current?.cancelAndRespawn();
          setIsSolving(false);
        }
      }

      if (options?.resetInfeasibleBlock !== false) {
        setIsSolveBlocked(false);
        setDiagnosis(null);
      }

      if (hasChromeStorageApi()) {
        lastPersistedJsonRef.current = JSON.stringify(next);
        void saveAcademicPlan(next).catch(() => {
          // Non-fatal storage error; keep UI state responsive.
        });
      }

      return next;
    },
    []
  );

  // 2. Initialize dedicated CP-SAT Web Worker + silent background warmup.
  useEffect(() => {
    const client = new SolverWorkerClient();
    workerClientRef.current = client;
    void client.warmup().catch(() => {
      // Actual solve invocation will surface initialization errors if WASM fails.
    });

    return () => {
      client.dispose();
      workerClientRef.current = null;
    };
  }, []);

  // 3. Synchronize AMIS session token across active tab & tab switches.
  useEffect(() => {
    if (!hasChromeTabsApi()) {
      setAuthToken(null);
      setAuthStatus('not_on_amis');
      return;
    }

    let cancelled = false;
    const syncStatusFromToken = async (token: string | null) => {
      if (cancelled) return;
      if (token) {
        setAuthToken(token);
        setAuthStatus('connected');
        return;
      }

      setAuthToken(null);
      try {
        const tab = await getActiveAmisTab();
        if (!cancelled) {
          setAuthStatus(tab ? 'unauthenticated' : 'not_on_amis');
        }
      } catch {
        if (!cancelled) {
          setAuthStatus('not_on_amis');
        }
      }
    };

    const unsubscribe = subscribeAuthTokenSync((token) => {
      void syncStatusFromToken(token);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // 4. Live AMIS Sync (term metadata, pre-enlisted courses, and refreshing intended courses).
  const syncFromAmis = useCallback(
    async (options?: { force?: boolean; tokenOverride?: string | null }) => {
      if (isSyncing) return;
      setSearchError(null);
      setStatusMessage(null);

      if (isOffline) {
        setStatusMessage(
          'Browser is offline. Live AMIS sync is unavailable, but local schedule optimization still works on cached courses.'
        );
        return;
      }

      let activeToken = options?.tokenOverride ?? authToken;
      if (!activeToken && hasChromeTabsApi()) {
        try {
          activeToken = await getAuthToken();
          if (activeToken) {
            setAuthToken(activeToken);
            setAuthStatus('connected');
          } else {
            const tab = await getActiveAmisTab();
            setAuthStatus(tab ? 'unauthenticated' : 'not_on_amis');
            return;
          }
        } catch {
          setAuthStatus('not_on_amis');
          return;
        }
      }

      if (!activeToken) {
        return;
      }

      const currentPlan = planRef.current;
      const isInitialOrError = currentPlan.termId === null || authStatus === 'expired';
      if (!options?.force && !isInitialOrError) {
        const cooldown = canManualRefresh(currentPlan.lastRefreshTime);
        if (!cooldown.allowed) {
          const remainingMin = Math.max(1, Math.ceil(cooldown.remainingMs / 60_000));
          setStatusMessage(
            `AMIS data was recently synced. Manual refresh available again in ${remainingMin} min.`
          );
          return;
        }
      }

      setIsSyncing(true);
      try {
        const termId = await fetchActiveTermId(activeToken);
        const userId = await fetchAuthUserId(activeToken);
        const { preEnlistedCourses } = await fetchStudentEnlistments(
          activeToken,
          termId,
          userId
        );

        let hadTransientRefreshError = false;
        const intendedOutcomes: SyncedCourseRefreshOutcome[] =
          planRef.current.intendedCourses.length > 0
            ? await Promise.all(
                planRef.current.intendedCourses.map(async (existing) => {
                  try {
                    const refreshedCourse = await fetchCourseWithClasses(
                      activeToken as string,
                      termId,
                      existing.code
                    );
                    return {
                      instanceId: existing.instanceId,
                      courseCode: existing.code,
                      refreshedCourse,
                    };
                  } catch (courseErr) {
                    if (
                      isAmisError(courseErr) &&
                      (courseErr.code === 'SESSION_EXPIRED' ||
                        courseErr.code === 'UNAUTHENTICATED')
                    ) {
                      throw courseErr;
                    }
                    if (
                      isAmisError(courseErr) &&
                      (courseErr.code === 'COURSE_NOT_FOUND' ||
                        courseErr.code === 'NO_CLASSES_FOUND')
                    ) {
                      return {
                        instanceId: existing.instanceId,
                        courseCode: existing.code,
                        notFoundOnNewTerm: true,
                      };
                    }
                    hadTransientRefreshError = true;
                    return {
                      instanceId: existing.instanceId,
                      courseCode: existing.code,
                    };
                  }
                })
              )
            : [];

        const { plan: updatedPlan, removedCourseCodes } = reconcileSyncedPlan(planRef.current, {
          termId,
          preEnlistedCourses,
          refreshedAt: new Date().toISOString(),
          intendedOutcomes,
        });

        commitPlan(() => updatedPlan);
        setAuthStatus('connected');

        const baseMsg = `Synced term ${termId} (${preEnlistedCourses.length} pre-enlisted course${
          preEnlistedCourses.length === 1 ? '' : 's'
        }).`;
        const extraNotes: string[] = [];
        if (removedCourseCodes.length > 0) {
          extraNotes.push(
            `Removed unavailable previous-term course(s): ${removedCourseCodes.join(', ')}.`
          );
        }
        if (hadTransientRefreshError) {
          extraNotes.push('Kept cached sections for courses that failed to refresh.');
        }
        setStatusMessage(extraNotes.length > 0 ? `${baseMsg} ${extraNotes.join(' ')}` : baseMsg);
      } catch (err) {
        if (isAmisError(err) && err.code === 'SESSION_EXPIRED') {
          setAuthStatus('expired');
          setAuthToken(null);
        } else if (isAmisError(err) && err.code === 'UNAUTHENTICATED') {
          setAuthStatus('unauthenticated');
          setAuthToken(null);
        } else if (isAmisError(err) && err.code === 'NOT_ON_AMIS_TAB') {
          setAuthStatus('not_on_amis');
        } else {
          setStatusMessage(formatAmisErrorMessage(err));
        }
      } finally {
        setIsSyncing(false);
      }
    },
    [authToken, authStatus, commitPlan, isOffline, isSyncing]
  );

  // Auto-sync once when storage is hydrated and a live AMIS auth token becomes available.
  useEffect(() => {
    if (!storageHydrated || !authToken || authStatus !== 'connected' || isOffline) {
      return;
    }
    if (autoSyncedTokenRef.current === authToken) {
      return;
    }

    const needsSync =
      planRef.current.termId === null || shouldAutoRefresh(planRef.current.lastRefreshTime);

    autoSyncedTokenRef.current = authToken;
    if (needsSync) {
      void syncFromAmis({ force: true, tokenOverride: authToken });
    }
  }, [storageHydrated, authToken, authStatus, isOffline, syncFromAmis]);

  // 5. Solver Execution (Phase 1 CP-SAT + automatic Phase 2 QuickXplain on INFEASIBLE).
  const runSolve = useCallback(async (targetPlan: AcademicPlanState) => {
    const client = workerClientRef.current;
    if (!client) return;

    const runId = ++solveRunIdRef.current;
    activeSolveRef.current = true;
    setIsSolving(true);
    setSearchError(null);

    try {
      const response = await client.solve(targetPlan);
      if (runId !== solveRunIdRef.current) {
        return;
      }
      if (response.status === 'OPTIMAL' || response.status === 'FEASIBLE') {
        setAlternatives(response.alternatives);
        setSelectedPlanIndex(0);
        setDiagnosis(null);
        setIsSolveBlocked(false);
      } else {
        setAlternatives([]);
        setSelectedPlanIndex(0);
        setDiagnosis(response.diagnosis);
        setIsSolveBlocked(true);
      }
    } catch (err) {
      if (runId !== solveRunIdRef.current || isSolverCancelledError(err)) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setSearchError(message);
    } finally {
      if (runId === solveRunIdRef.current) {
        activeSolveRef.current = false;
        setIsSolving(false);
      }
    }
  }, []);

  const handleGenerateSchedules = useCallback(() => {
    void runSolve(planRef.current);
  }, [runSolve]);

  const handleCancelSolve = useCallback(() => {
    solveRunIdRef.current += 1;
    activeSolveRef.current = false;
    workerClientRef.current?.cancelAndRespawn();
    setIsSolving(false);
  }, []);

  // 6. Course Search & Section Fetch (Milestone 2).
  const handleSearchSuggestions = useCallback(
    async (query: string): Promise<RawAmisCourse[]> => {
      if (isOffline || !authToken) {
        return [];
      }
      try {
        return await searchCoursesByCode(authToken, query);
      } catch (err) {
        if (isAmisError(err) && err.code === 'SESSION_EXPIRED') {
          setAuthStatus('expired');
          setAuthToken(null);
        }
        return [];
      }
    },
    [authToken, isOffline]
  );

  const handleAddCourseByCode = useCallback(
    async (courseCode: string): Promise<boolean> => {
      setSearchError(null);
      setStatusMessage(null);

      if (isOffline) {
        setSearchError('Browser is offline. Course search requires an active internet connection.');
        return false;
      }

      if (!authToken) {
        setSearchError(
          'Connect to a logged-in UPLB AMIS tab first before searching for courses.'
        );
        return false;
      }

      setIsAddingCourse(true);
      try {
        let termId = planRef.current.termId;
        if (termId === null) {
          termId = await fetchActiveTermId(authToken);
        }

        const fetchedCourse = await fetchCourseWithClasses(authToken, termId, courseCode);
        commitPlan((prev) => ({
          ...addOrUpdateIntendedCourse(prev, fetchedCourse),
          termId,
        }));
        return true;
      } catch (err) {
        if (isAmisError(err) && err.code === 'SESSION_EXPIRED') {
          setAuthStatus('expired');
          setAuthToken(null);
        } else if (isAmisError(err) && err.code === 'UNAUTHENTICATED') {
          setAuthStatus('unauthenticated');
          setAuthToken(null);
        }
        setSearchError(formatAmisErrorMessage(err));
        return false;
      } finally {
        setIsAddingCourse(false);
      }
    },
    [authToken, commitPlan, isOffline]
  );

  // 7. Interactive Timetable, Course Flags, Preferences, and HITL Relaxations.
  const handleToggleCell = useCallback(
    (day: Weekday, startMinutes: number) => {
      commitPlan((prev) => toggleBlockedCell(prev, day, startMinutes));
    },
    [commitPlan]
  );

  const handleToggleAccordion = useCallback(
    (instanceId: string) => {
      commitPlan((prev) => toggleCourseAccordion(prev, instanceId), {
        resetInfeasibleBlock: false,
        preserveSchedule: true,
      });
    },
    [commitPlan]
  );

  const handleToggleSectionFlag = useCallback(
    (instanceId: string, sectionId: string, flag: 'isHidden' | 'isLocked' | 'isStarred') => {
      commitPlan((prev) => toggleSectionFlag(prev, instanceId, sectionId, flag));
    },
    [commitPlan]
  );

  const handleRemoveCourse = useCallback(
    (instanceId: string) => {
      commitPlan((prev) => removeIntendedCourse(prev, instanceId));
    },
    [commitPlan]
  );

  const handleChangePreferences = useCallback(
    (updater: (prev: StudentPreferences) => StudentPreferences) => {
      commitPlan((prev) => updatePreferences(prev, updater));
    },
    [commitPlan]
  );

  const handleApplyConstraints = useCallback(() => {
    const current = planRef.current;
    if (hasChromeStorageApi()) {
      lastPersistedJsonRef.current = JSON.stringify(current);
      void saveAcademicPlan(current).catch(() => {});
    }
    if (current.preEnlistedCourses.length > 0 || current.intendedCourses.length > 0) {
      void runSolve(current);
    } else {
      setActiveTab('courses');
      setStatusMessage('Preferences saved. Add at least one course to generate schedules.');
    }
  }, [runSolve]);

  const handleApplyRelaxation = useCallback(
    (action: RelaxationAction) => {
      const nextPlan = commitPlan((prev) => applyRelaxationActionToPlan(prev, action));
      if (action.actionType === 'DROP_OR_REPLACE_COURSE') {
        setActiveTab('courses');
      }
      if (nextPlan.preEnlistedCourses.length > 0 || nextPlan.intendedCourses.length > 0) {
        void runSolve(nextPlan);
      } else if (action.actionType === 'DROP_OR_REPLACE_COURSE') {
        setStatusMessage('Dropped conflicting course. Search above to add an alternative course.');
      }
    },
    [commitPlan, runSolve]
  );

  // 8. Overlay / Popup Dismissal & Expansion.
  const handleDismiss = useCallback(() => {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'AMISYNC_DISMISS_OVERLAY' }, '*');
    } else {
      window.close();
    }
  }, []);

  const handleExpandOverlay = useCallback(() => {
    const g = globalThis as {
      chrome?: { runtime?: { sendMessage?: (msg: { type: string }) => Promise<unknown> } };
    };
    if (g.chrome?.runtime?.sendMessage) {
      void g.chrome.runtime
        .sendMessage({ type: 'AMISYNC_TOGGLE_OVERLAY' })
        .then(() => {
          window.close();
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleDismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleDismiss]);

  const activeAlternative = alternatives[selectedPlanIndex] ?? null;
  const fallbackTotalUnits = useMemo(() => computePlanUnits(plan), [plan]);
  const hasAnyCourse =
    plan.preEnlistedCourses.length > 0 || plan.intendedCourses.length > 0;
  const hardClashCount = diagnosis ? diagnosis.hardClashCount : 0;

  return (
    <div className="app-shell">
      <TopBar
        canExpandOverlay={!isInIframe && authStatus !== 'not_on_amis' && hasChromeTabsApi()}
        onExpandOverlay={handleExpandOverlay}
        onDismiss={handleDismiss}
      />

      <main className="optimizer-workspace">
        {/* Left Pane (~60%): Plan Bar, Interactive Timetable, Schedule Conflicts, Footer Check */}
        <section className="left-pane" aria-label="Timetable and Conflict Diagnosis">
          <PlanBar
            alternatives={alternatives}
            selectedPlanIndex={selectedPlanIndex}
            fallbackTotalUnits={fallbackTotalUnits}
            isInfeasible={diagnosis !== null}
            onSelectPlan={setSelectedPlanIndex}
          />

          <TimetableGrid
            plan={plan}
            activeAlternative={activeAlternative}
            isSolving={isSolving}
            onToggleCell={handleToggleCell}
          />

          <ScheduleConflictsPanel
            diagnosis={diagnosis}
            isSolving={isSolving}
            onApplyRelaxation={handleApplyRelaxation}
          />

          <LeftFooterStrip
            hardClashCount={hardClashCount}
            isSolving={isSolving}
            onOpenPreferences={() => setActiveTab('preferences')}
          />
        </section>

        {/* Right Pane (~40%): Two-Tab Workspace (Courses | Preferences & Weights) */}
        <aside className="right-pane" aria-label="Courses and Preferences">
          <div className="right-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'courses'}
              className={`right-tabs__btn ${
                activeTab === 'courses' ? 'right-tabs__btn--active' : ''
              }`}
              onClick={() => setActiveTab('courses')}
            >
              Courses
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'preferences'}
              className={`right-tabs__btn ${
                activeTab === 'preferences' ? 'right-tabs__btn--active' : ''
              }`}
              onClick={() => setActiveTab('preferences')}
            >
              Preferences &amp; Weights
            </button>
          </div>

          <div className="right-pane__content">
            {activeTab === 'courses' ? (
              <CoursesTab
                intendedCourses={plan.intendedCourses}
                preEnlistedCourses={plan.preEnlistedCourses}
                authStatus={authStatus}
                isOffline={isOffline}
                statusMessage={statusMessage}
                searchError={searchError}
                isSyncing={isSyncing}
                isAddingCourse={isAddingCourse}
                isSolving={isSolving}
                isSolveBlocked={isSolveBlocked}
                canGenerate={hasAnyCourse}
                onSyncAmis={() => void syncFromAmis({ force: false })}
                onSearchSuggestions={handleSearchSuggestions}
                onAddCourseByCode={handleAddCourseByCode}
                onRemoveCourse={handleRemoveCourse}
                onToggleAccordion={handleToggleAccordion}
                onToggleSectionFlag={handleToggleSectionFlag}
                onGenerateSchedules={handleGenerateSchedules}
                onCancelSolve={handleCancelSolve}
              />
            ) : (
              <PreferencesTab
                preferences={plan.preferences}
                isSolving={isSolving}
                onChangePreferences={handleChangePreferences}
                onBack={() => setActiveTab('courses')}
                onApplyConstraints={handleApplyConstraints}
              />
            )}
          </div>
        </aside>
      </main>

      <footer className="bottom-strip">
        <span>
          Press <kbd className="esc-keycap">Esc</kbd> to dismiss
        </span>
      </footer>
    </div>
  );
}
