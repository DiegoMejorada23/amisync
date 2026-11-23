import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fetchCourseWithClasses,
  fetchStudentEnlistments,
  type AmisHttpExecutor,
} from '../src/amis/client.ts';
import { isAmisError } from '../src/amis/errors.ts';
import { validateAcademicPlanState } from '../src/amis/snapshot.ts';
import {
  loadAcademicPlan,
  PLAN_STORAGE_KEY,
  saveAcademicPlan,
  subscribeAcademicPlanChanges,
  type StorageAreaLike,
  type StorageChangeEntry,
} from '../src/storage/planStorage.ts';
import { solveAcademicPlan } from '../src/solver/engine.ts';
import {
  buildForegroundConstraints,
  buildPureSatSubsetModel,
  createQuickXplainBudget,
  verifyMusProperties,
} from '../src/solver/quickxplain.ts';
import { preprocessAcademicPlan } from '../src/solver/preprocess.ts';
import { computeScheduleValidityRate } from '../src/solver/validator.ts';
import {
  createDefaultAcademicPlanState,
  PLAN_SCHEMA_VERSION,
  WEEKDAYS,
  type AcademicPlanState,
  type CourseEntry,
  type Weekday,
} from '../src/types/domain.ts';
import { applyRelaxationActionToPlan, reconcileSyncedPlan } from '../src/ui/planActions.ts';
import { isSolverCancelledError, SolverWorkerClient } from '../src/ui/workerClient.ts';

function createDelayedMemoryStorage(
  initial: Record<string, unknown> = {},
  getSetDelayMs?: (callIndex: number) => number
): { storage: StorageAreaLike; rawStore: Map<string, unknown> } {
  const rawStore = new Map<string, unknown>(Object.entries(initial));
  let setCallCount = 0;

  const storage: StorageAreaLike = {
    async get(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of keyList) {
        if (rawStore.has(key)) {
          out[key] = structuredClone(rawStore.get(key));
        }
      }
      return out;
    },
    async set(items) {
      const idx = ++setCallCount;
      const delay = getSetDelayMs ? getSetDelayMs(idx) : 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      for (const [k, v] of Object.entries(items)) {
        rawStore.set(k, structuredClone(v));
      }
    },
    async remove(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        rawStore.delete(key);
      }
    },
  };

  return { storage, rawStore };
}

function makeCourse(
  id: string,
  code: string,
  units: number,
  sections: Array<{
    id: string;
    section: string;
    days: Weekday[];
    startMinutes: number;
    endMinutes: number;
    active?: number;
    max?: number;
    isHidden?: boolean;
    isLocked?: boolean;
    isStarred?: boolean;
    isPreEnlisted?: boolean;
  }>,
  options?: { isPreEnlisted?: boolean }
): CourseEntry {
  const coursePre = Boolean(options?.isPreEnlisted);
  return {
    instanceId: `inst-${id}`,
    id,
    code,
    units,
    canEnrollMultiple: false,
    isPreEnlisted: coursePre,
    requiredComponents: ['LEC'],
    isExpanded: true,
    sections: sections.map((s) => ({
      isPreEnlisted: Boolean(s.isPreEnlisted ?? coursePre),
      flags: {
        isHidden: Boolean(s.isHidden),
        isLocked: Boolean(s.isLocked),
        isStarred: Boolean(s.isStarred),
      },
      section: {
        id: s.id,
        courseId: id,
        section: s.section,
        activity: 'LEC',
        faculties: [{ firstName: 'A', middleName: '', lastName: 'Prof' }],
        location: 'ICS LH1',
        dates:
          s.days.length === 0
            ? []
            : [
                {
                  days: s.days,
                  startTime: `${s.startMinutes}`,
                  endTime: `${s.endMinutes}`,
                  startMinutes: s.startMinutes,
                  endMinutes: s.endMinutes,
                },
              ],
        activeClassSize: s.active ?? 5,
        maxClassSize: s.max ?? 30,
        isPrerogOpen: false,
        parentClassId: null,
        parentClass: null,
      },
    })),
  };
}

class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  postedMessages: unknown[] = [];

  postMessage(data: unknown): void {
    this.postedMessages.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  emitError(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

describe('Milestone 6: Storage, Write Queue & Cache Sync Hardening', () => {
  it('round-trips full AcademicPlanState and self-heals deeply corrupted storage entries', async () => {
    const plan = createDefaultAcademicPlanState();
    plan.termId = 125;
    plan.lastRefreshTime = '2026-11-23T12:00:00.000Z';
    plan.blockedCells.push({
      id: 'Tuesday:780-840',
      day: 'Tuesday',
      startMinutes: 780,
      endMinutes: 840,
    });
    plan.intendedCourses = [
      makeCourse('101', 'CMSC 128', 3, [
        {
          id: '101-A',
          section: 'A',
          days: ['Monday', 'Wednesday'],
          startMinutes: 540,
          endMinutes: 600,
          isStarred: true,
        },
      ]),
    ];

    const { storage, rawStore } = createDelayedMemoryStorage();
    await saveAcademicPlan(plan, storage);
    const loaded = await loadAcademicPlan(storage);
    assert.equal(loaded.termId, 125);
    assert.equal(loaded.intendedCourses[0].sections[0].flags.isStarred, true);
    assert.equal(loaded.blockedCells.length, 1);

    // Inject deeply corrupted payloads (invalid slider bounds, bad priority, malformed section)
    const badPayloads: unknown[] = [
      {
        ...structuredClone(plan),
        preferences: {
          ...plan.preferences,
          fatigueLimit: { priority: 'High', maxConsecutiveHours: 99 },
        },
      },
      {
        ...structuredClone(plan),
        preferences: {
          ...plan.preferences,
          acceptableDayBounds: {
            priority: 'High',
            earliestStartMinutes: 900,
            latestEndMinutes: 600,
          },
        },
      },
      {
        ...structuredClone(plan),
        blockedCells: [{ id: 'bad', day: 'Sunday', startMinutes: 420, endMinutes: 480 }],
      },
      {
        ...structuredClone(plan),
        intendedCourses: [{ instanceId: 'x', id: '1', code: 'BAD', units: -5, sections: [] }],
      },
    ];

    for (const bad of badPayloads) {
      assert.throws(() => validateAcademicPlanState(bad), (err) => isAmisError(err));
      rawStore.set(PLAN_STORAGE_KEY, bad);
      const recovered = await loadAcademicPlan(storage);
      assert.equal(recovered.schemaVersion, PLAN_SCHEMA_VERSION);
      assert.equal(recovered.termId, null);
      assert.deepEqual(recovered.intendedCourses, []);
      // Self-healed storage removes corrupted key
      assert.equal(rawStore.has(PLAN_STORAGE_KEY), false);
    }

    // Schema version mismatch also self-heals on loadAcademicPlan
    rawStore.set(PLAN_STORAGE_KEY, { ...structuredClone(plan), schemaVersion: '0.9.0' });
    const migrated = await loadAcademicPlan(storage);
    assert.equal(migrated.schemaVersion, PLAN_SCHEMA_VERSION);
    assert.equal(migrated.termId, null);
    assert.equal(rawStore.has(PLAN_STORAGE_KEY), false);
  });

  it('serializes concurrent saveAcademicPlan writes so slower earlier writes never clobber newer state', async () => {
    // Earlier writes take longer (40ms, 25ms) while final write is immediate (1ms).
    const delays = [40, 25, 1];
    const { storage } = createDelayedMemoryStorage({}, (idx) => delays[idx - 1] ?? 0);

    const p1 = createDefaultAcademicPlanState();
    p1.termId = 1;
    const p2 = createDefaultAcademicPlanState();
    p2.termId = 2;
    const p3 = createDefaultAcademicPlanState();
    p3.termId = 3;

    await Promise.all([
      saveAcademicPlan(p1, storage),
      saveAcademicPlan(p2, storage),
      saveAcademicPlan(p3, storage),
    ]);

    const finalLoaded = await loadAcademicPlan(storage);
    assert.equal(finalLoaded.termId, 3);
  });

  it('propagates valid external chrome.storage.onChanged updates and ignores malformed/non-local updates', () => {
    const listeners = new Set<
      (changes: Record<string, StorageChangeEntry>, areaName: string) => void
    >();
    const onChanged = {
      addListener(
        fn: (changes: Record<string, StorageChangeEntry>, areaName: string) => void
      ) {
        listeners.add(fn);
      },
      removeListener(
        fn: (changes: Record<string, StorageChangeEntry>, areaName: string) => void
      ) {
        listeners.delete(fn);
      },
    };

    const received: AcademicPlanState[] = [];
    const unsubscribe = subscribeAcademicPlanChanges((p) => received.push(p), onChanged);

    const validPlan = createDefaultAcademicPlanState();
    validPlan.termId = 777;

    for (const fn of listeners) {
      fn({ [PLAN_STORAGE_KEY]: { newValue: validPlan } }, 'sync'); // ignored area
      fn({ [PLAN_STORAGE_KEY]: { newValue: { broken: true } } }, 'local'); // ignored malformed
      fn({ [PLAN_STORAGE_KEY]: { newValue: validPlan } }, 'local'); // accepted
    }

    assert.equal(received.length, 1);
    assert.equal(received[0].termId, 777);

    unsubscribe();
    assert.equal(listeners.size, 0);
  });

  it('reconciles term transitions by evicting unavailable courses while keeping transient failures', () => {
    let plan = createDefaultAcademicPlanState();
    plan.termId = 100;
    const cmsc128 = makeCourse('128', 'CMSC 128', 3, [
      { id: '128-A', section: 'A', days: ['Monday'], startMinutes: 540, endMinutes: 600 },
    ]);
    const oldElec = makeCourse('999', 'OLD 101', 3, [
      { id: '999-A', section: 'A', days: ['Tuesday'], startMinutes: 540, endMinutes: 600 },
    ]);
    plan.intendedCourses = [cmsc128, oldElec];

    const refreshedCmsc128 = makeCourse('128', 'CMSC 128', 3, [
      { id: '128-A', section: 'A', days: ['Monday'], startMinutes: 540, endMinutes: 600, active: 20 },
    ]);

    const { plan: nextPlan, removedCourseCodes } = reconcileSyncedPlan(plan, {
      termId: 101,
      preEnlistedCourses: [],
      refreshedAt: '2026-11-23T12:00:00.000Z',
      intendedOutcomes: [
        { instanceId: cmsc128.instanceId, courseCode: 'CMSC 128', refreshedCourse: refreshedCmsc128 },
        { instanceId: oldElec.instanceId, courseCode: 'OLD 101', notFoundOnNewTerm: true },
      ],
    });

    assert.equal(nextPlan.termId, 101);
    assert.deepEqual(removedCourseCodes, ['OLD 101']);
    assert.equal(nextPlan.intendedCourses.length, 1);
    assert.equal(nextPlan.intendedCourses[0].sections[0].section.activeClassSize, 20);
  });
});

describe('Milestone 6: Edge Cases, Session/Offline Recovery & Rapid Re-Solve Cancellation', () => {
  it('handles empty course lists cleanly (both unconstrained and minUnits > 0)', async () => {
    const emptyPlan = createDefaultAcademicPlanState();
    const okResult = await solveAcademicPlan(emptyPlan);
    assert.equal(okResult.status, 'OPTIMAL');
    assert.equal(okResult.alternatives.length, 1);
    assert.equal(okResult.alternatives[0].totalUnits, 0);
    assert.deepEqual(okResult.alternatives[0].selectedSectionIds, []);

    const constrainedEmpty = createDefaultAcademicPlanState();
    constrainedEmpty.unitLimits = { minUnits: 12 };
    const failResult = await solveAcademicPlan(constrainedEmpty);
    assert.equal(failResult.status, 'INFEASIBLE');
    assert.equal(failResult.diagnosis?.origin, 'DATA_INCONSISTENCY');
  });

  it('recovers gracefully from zero-open/all-TBA courses via EXHAUSTED_CAPACITY and 1-click drop', async () => {
    const plan = createDefaultAcademicPlanState();
    plan.intendedCourses = [
      makeCourse('1', 'CMSC 21', 3, [
        { id: '1-A', section: 'A', days: ['Monday'], startMinutes: 540, endMinutes: 600, active: 25, max: 25 },
        { id: '1-TBA', section: 'B', days: [], startMinutes: 0, endMinutes: 0, active: 0, max: 25 },
      ]),
      makeCourse('2', 'STAT 1', 3, [
        { id: '2-A', section: 'A', days: ['Tuesday'], startMinutes: 540, endMinutes: 600 },
      ]),
    ];

    const res1 = await solveAcademicPlan(plan);
    assert.equal(res1.status, 'INFEASIBLE');
    assert.equal(res1.diagnosis?.origin, 'EXHAUSTED_CAPACITY');
    assert.deepEqual(res1.diagnosis?.affectedCourseCodes, ['CMSC 21']);

    const dropAction = res1.diagnosis?.relaxationActions?.find(
      (a) => a.actionType === 'DROP_OR_REPLACE_COURSE'
    );
    assert.ok(dropAction);

    const relaxed = applyRelaxationActionToPlan(plan, dropAction);
    const res2 = await solveAcademicPlan(relaxed);
    assert.equal(res2.status, 'OPTIMAL');
    assert.equal(res2.alternatives[0].totalUnits, 3);
    assert.deepEqual(res2.alternatives[0].selectedSectionIds, ['2-A']);
  });

  it('surfaces SESSION_EXPIRED on 401/403 and NETWORK_ERROR when offline', async () => {
    const expiredExecutor: AmisHttpExecutor = async () => ({
      ok: false,
      status: 401,
      body: { message: 'Token expired' },
    });

    await assert.rejects(
      () => fetchStudentEnlistments('Bearer expired', 123, 'u1', expiredExecutor),
      (err) => isAmisError(err) && err.code === 'SESSION_EXPIRED'
    );

    const offlineExecutor: AmisHttpExecutor = async () => ({
      ok: false,
      status: 0,
      body: null,
      networkError: 'Browser is offline. Unable to reach UPLB AMIS.',
    });

    await assert.rejects(
      () => fetchCourseWithClasses('Bearer valid', 123, 'CMSC 128', offlineExecutor),
      (err) => isAmisError(err) && err.code === 'NETWORK_ERROR'
    );
  });

  it('cancels superseded rapid re-solve calls, drops stale worker responses, and recovers from worker crash', async () => {
    const spawnedWorkers: MockWorker[] = [];
    const client = new SolverWorkerClient({
      workerFactory: () => {
        const w = new MockWorker();
        spawnedWorkers.push(w);
        return w as unknown as Worker;
      },
      timeoutMs: 5_000,
    });

    const plan = createDefaultAcademicPlanState();

    // Fire 3 rapid solve requests without awaiting the first two.
    const p1 = client.solve(plan);
    const p2 = client.solve(plan);
    const p3 = client.solve(plan);

    assert.equal(spawnedWorkers.length, 3);
    assert.equal(spawnedWorkers[0].terminated, true);
    assert.equal(spawnedWorkers[1].terminated, true);
    assert.equal(spawnedWorkers[2].terminated, false);

    await assert.rejects(p1, (err) => isSolverCancelledError(err));
    await assert.rejects(p2, (err) => isSolverCancelledError(err));

    const req1 = spawnedWorkers[0].postedMessages[0] as { requestId: string };
    const req3 = spawnedWorkers[2].postedMessages[0] as { requestId: string };

    // Late message from worker 0 or wrong requestId on worker 2 must be ignored.
    spawnedWorkers[0].emitMessage({
      type: 'SOLVE_SCHEDULE_RESULT',
      requestId: req1.requestId,
      ok: true,
      payload: {
        status: 'OPTIMAL',
        alternatives: [],
        diagnosis: null,
        timing: { wasmInitMs: 0, modelConstructionMs: 0, solverExecutionMs: 0 },
      },
    });

    // Emit valid result for latest requestId on worker 2.
    spawnedWorkers[2].emitMessage({
      type: 'SOLVE_SCHEDULE_RESULT',
      requestId: req3.requestId,
      ok: true,
      payload: {
        status: 'OPTIMAL',
        alternatives: [
          {
            planLabel: 'Plan A',
            profileTag: 'Balanced',
            totalUnits: 0,
            status: 'OPTIMAL',
            objectiveScoreZ: 0,
            selectedSectionIds: [],
            hammingDistanceFromPrev: [],
          },
        ],
        diagnosis: null,
        timing: { wasmInitMs: 1, modelConstructionMs: 1, solverExecutionMs: 2 },
      },
    });

    const resolved = await p3;
    assert.equal(resolved.status, 'OPTIMAL');

    // Simulate worker crash and verify clean respawn on next solve.
    const p4 = client.solve(plan);
    assert.equal(spawnedWorkers.length, 3); // reused warm worker 2
    spawnedWorkers[2].emitError('Simulated WASM OOM');
    await assert.rejects(p4, /Simulated WASM OOM/);
    assert.equal(spawnedWorkers[2].terminated, true);

    const p5 = client.solve(plan);
    assert.equal(spawnedWorkers.length, 4); // fresh worker 3 spawned
    const req5 = spawnedWorkers[3].postedMessages[0] as { requestId: string };
    spawnedWorkers[3].emitMessage({
      type: 'SOLVE_SCHEDULE_RESULT',
      requestId: req5.requestId,
      ok: true,
      payload: {
        status: 'OPTIMAL',
        alternatives: [],
        diagnosis: null,
        timing: { wasmInitMs: 1, modelConstructionMs: 1, solverExecutionMs: 1 },
      },
    });
    const recovered = await p5;
    assert.equal(recovered.status, 'OPTIMAL');

    client.dispose();
  });
});

describe('Milestone 6: Large-Tier Scalability, 100% SVR & QuickXplain Latency', () => {
  it('solves an 8-course Large-tier schedule (96 section options) with 100% SVR in < 5.0s', async () => {
    const plan = createDefaultAcademicPlanState();
    plan.blockedCells = [
      { id: 'Saturday:420-480', day: 'Saturday', startMinutes: 420, endMinutes: 480 },
    ];

    const slotTimes: Array<[number, number]> = [
      [480, 570],
      [570, 660],
      [660, 750],
      [780, 870],
      [870, 960],
      [960, 1050],
    ];

    const courses: CourseEntry[] = [];
    for (let c = 0; c < 8; c++) {
      const sections: Parameters<typeof makeCourse>[3] = [];
      for (let s = 0; s < 12; s++) {
        const dayA = WEEKDAYS[(c + s) % 5];
        const dayB = WEEKDAYS[(c + s + 2) % 5];
        const [start, end] = slotTimes[(c + s) % slotTimes.length];
        sections.push({
          id: `L-${c}-${s}`,
          section: `S${s + 1}`,
          days: s % 2 === 0 ? [dayA] : [dayA, dayB],
          startMinutes: start,
          endMinutes: end,
          isStarred: s === 0,
        });
      }
      courses.push(makeCourse(`large-${c}`, `COURSE ${100 + c}`, 3, sections));
    }
    plan.intendedCourses = courses;

    const result = await solveAcademicPlan(plan, { maxTimeInSeconds: 10.0, randomSeed: 42 });
    assert.ok(result.status === 'OPTIMAL' || result.status === 'FEASIBLE');
    assert.equal(result.alternatives.length, 3);
    const perSolveMs = result.timing.solverExecutionMs / result.alternatives.length;
    assert.ok(
      perSolveMs < 5000 && result.timing.solverExecutionMs < 10000,
      `Expected Large-tier per-solve < 5000ms and total < 10000ms, got total=${result.timing.solverExecutionMs}ms (avg=${perSolveMs.toFixed(1)}ms)`
    );

    const svr = computeScheduleValidityRate(plan, result.alternatives);
    assert.equal(svr.scheduleValidityRate, 1);
  });

  it('extracts a provably irreducible MUS on a multi-course infeasible scenario in < 5.0s', async () => {
    const plan = createDefaultAcademicPlanState();
    plan.intendedCourses = [
      makeCourse('201', 'CMSC 141', 3, [
        { id: '201-A', section: 'A', days: ['Monday'], startMinutes: 600, endMinutes: 690 },
      ]),
      makeCourse('202', 'CMSC 142', 3, [
        { id: '202-A', section: 'A', days: ['Monday'], startMinutes: 630, endMinutes: 720 },
      ]),
      makeCourse('203', 'MATH 28', 3, [
        { id: '203-A', section: 'A', days: ['Tuesday'], startMinutes: 480, endMinutes: 570 },
        { id: '203-B', section: 'B', days: ['Wednesday'], startMinutes: 480, endMinutes: 570 },
      ]),
      makeCourse('204', 'PHYS 51', 3, [
        { id: '204-A', section: 'A', days: ['Thursday'], startMinutes: 570, endMinutes: 660 },
        { id: '204-B', section: 'B', days: ['Friday'], startMinutes: 570, endMinutes: 660 },
      ]),
    ];
    plan.blockedCells = [
      { id: 'Wednesday:780-840', day: 'Wednesday', startMinutes: 780, endMinutes: 840 },
    ];

    const result = await solveAcademicPlan(plan, { randomSeed: 7 });
    assert.equal(result.status, 'INFEASIBLE');
    assert.ok(result.diagnosis);
    assert.equal(result.diagnosis.origin, 'PREFERENCE_CONFLICT');
    assert.deepEqual(result.diagnosis.affectedCourseCodes.sort(), ['CMSC 141', 'CMSC 142']);
    assert.ok((result.timing.musExtractionMs ?? 0) < 5000);

    // Independent mathematical verification of MUS irreducibility
    const problem = preprocessAcademicPlan(plan);
    const allItems = buildForegroundConstraints(problem, plan);
    const musKeys = new Set(
      result.diagnosis.mus.map((m) =>
        m.kind === 'INTENDED_COURSE'
          ? `INTENDED_COURSE:inst-${m.courseId}`
          : m.kind === 'TIME_BLOCK'
            ? `TIME_BLOCK:${m.blockId}`
            : ''
      )
    );
    const musItems = allItems.filter((it) => musKeys.has(it.key));
    const report = await verifyMusProperties(problem, musItems, createQuickXplainBudget());
    assert.equal(report.isValidMus, true);
    assert.equal(report.isUnsatisfiable, true);
    assert.equal(report.isIrreducible, true);
    assert.equal(buildPureSatSubsetModel(problem, []).triviallyInfeasible, false);
  });
});
