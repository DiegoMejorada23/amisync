import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createDefaultAcademicPlanState,
  type CourseEntry,
  type NormalizedSection,
} from '../src/types/domain.ts';
import type {
  WorkerSmokeTestRequest,
  WorkerSolveRequest,
} from '../src/types/worker.ts';
import { handleWorkerRequest } from '../src/workers/solver.worker.ts';

function makeSimpleCourse(
  id: string,
  code: string,
  sections: Array<{
    id: string;
    section: string;
    day: 'Monday' | 'Tuesday' | 'Wednesday';
    start: number;
    end: number;
  }>
): CourseEntry {
  const normSections: NormalizedSection[] = sections.map((s) => ({
    id: s.id,
    courseId: id,
    section: s.section,
    activity: 'LEC',
    faculties: [],
    location: 'ICS LH1',
    dates: [
      {
        days: [s.day],
        startTime: `${s.start}`,
        endTime: `${s.end}`,
        startMinutes: s.start,
        endMinutes: s.end,
      },
    ],
    activeClassSize: 5,
    maxClassSize: 30,
    isPrerogOpen: false,
    parentClassId: null,
    parentClass: null,
  }));

  return {
    instanceId: `w-inst-${id}`,
    id,
    code,
    units: 3,
    canEnrollMultiple: false,
    isPreEnlisted: false,
    requiredComponents: ['LEC'],
    sections: normSections.map((sec) => ({
      section: sec,
      flags: { isHidden: false, isLocked: false, isStarred: false },
      isPreEnlisted: false,
    })),
    isExpanded: true,
  };
}

describe('Solver Web Worker Typed Request/Response Protocol', () => {
  it('handles SMOKE_TEST request and confirms WASM CP-SAT readiness', async () => {
    const req: WorkerSmokeTestRequest = { type: 'SMOKE_TEST' };
    const res = await handleWorkerRequest(req);

    assert.ok(res);
    assert.equal(res.type, 'SMOKE_TEST_RESULT');
    assert.equal(res.ok, true);
    assert.equal(res.smokeSolveStatus, 'OPTIMAL');
    assert.equal(res.variableValue, 1);
    assert.ok(res.wasmInitMs >= 0);
  });

  it('handles SOLVE_SCHEDULE request returning feasible optimal alternatives and timing profile', async () => {
    const plan = createDefaultAcademicPlanState();
    plan.intendedCourses = [
      makeSimpleCourse('1', 'CMSC 11', [
        { id: '1-A', section: 'A', day: 'Monday', start: 540, end: 600 },
        { id: '1-B', section: 'B', day: 'Tuesday', start: 540, end: 600 },
      ]),
      makeSimpleCourse('2', 'MATH 27', [
        { id: '2-A', section: 'A', day: 'Monday', start: 600, end: 660 },
        { id: '2-B', section: 'B', day: 'Wednesday', start: 600, end: 660 },
      ]),
    ];

    const req: WorkerSolveRequest = {
      type: 'SOLVE_SCHEDULE',
      requestId: 'req-feasible-001',
      plan,
      options: { maxTimeInSeconds: 10.0 },
    };

    const res = await handleWorkerRequest(req);
    assert.ok(res);
    assert.equal(res.type, 'SOLVE_SCHEDULE_RESULT');
    assert.equal(res.requestId, 'req-feasible-001');
    assert.equal(res.ok, true);
    assert.ok(res.payload);
    assert.equal(res.payload.status, 'OPTIMAL');
    assert.equal(res.payload.alternatives.length, 3);
    assert.equal(res.payload.diagnosis, null);
    assert.ok(res.payload.timing.modelConstructionMs >= 0);
    assert.ok(res.payload.timing.solverExecutionMs >= 0);
  });

  it('handles SOLVE_SCHEDULE request returning clean structured INFEASIBLE status on conflict', async () => {
    const plan = createDefaultAcademicPlanState();
    plan.intendedCourses = [
      makeSimpleCourse('10', 'CMSC 141', [
        { id: '10-A', section: 'A', day: 'Monday', start: 600, end: 690 },
      ]),
      makeSimpleCourse('11', 'CMSC 142', [
        { id: '11-A', section: 'A', day: 'Monday', start: 630, end: 720 },
      ]),
    ];

    const req: WorkerSolveRequest = {
      type: 'SOLVE_SCHEDULE',
      requestId: 'req-infeasible-002',
      plan,
    };

    const res = await handleWorkerRequest(req);
    assert.ok(res);
    assert.equal(res.type, 'SOLVE_SCHEDULE_RESULT');
    assert.equal(res.requestId, 'req-infeasible-002');
    assert.equal(res.ok, true);
    assert.ok(res.payload);
    assert.equal(res.payload.status, 'INFEASIBLE');
    assert.deepEqual(res.payload.alternatives, []);
    assert.equal(res.payload.diagnosis, null);
  });
});
