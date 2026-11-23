import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeScheduleValidityRate,
  solveAcademicPlan,
  validateScheduleAlternative,
} from '../src/solver/index.ts';
import {
  createDefaultAcademicPlanState,
  type AcademicPlanState,
  type CourseEntry,
  type NormalizedSection,
  type TimeslotInterval,
  type Weekday,
} from '../src/types/domain.ts';
import type { GeneratedScheduleAlternative } from '../src/types/solver.ts';

function slot(days: Weekday[], startMinutes: number, endMinutes: number): TimeslotInterval {
  return {
    days,
    startTime: `${startMinutes}`,
    endTime: `${endMinutes}`,
    startMinutes,
    endMinutes,
  };
}

function section(
  id: string,
  courseId: string,
  name: string,
  activity: string,
  dates: TimeslotInterval[],
  opts?: {
    active?: number;
    max?: number;
    parentClass?: NormalizedSection | null;
    parentClassId?: string | null;
  }
): NormalizedSection {
  return {
    id,
    courseId,
    section: name,
    activity,
    faculties: [],
    location: 'ICS',
    dates,
    activeClassSize: opts?.active ?? 5,
    maxClassSize: opts?.max ?? 25,
    isPrerogOpen: false,
    parentClassId: opts?.parentClass ? opts.parentClass.id : (opts?.parentClassId ?? null),
    parentClass: opts?.parentClass ?? null,
  };
}

function makeAlt(selectedSectionIds: string[]): GeneratedScheduleAlternative {
  return {
    planLabel: 'Plan A',
    profileTag: 'Balanced',
    totalUnits: 6,
    status: 'OPTIMAL',
    objectiveScoreZ: 0,
    selectedSectionIds,
    hammingDistanceFromPrev: [],
  };
}

function buildSamplePlan(): AcademicPlanState {
  const plan = createDefaultAcademicPlanState();

  const preSec = section('PRE-1', '10', 'S', 'LEC', [slot(['Tuesday'], 420, 480)], {
    active: 25,
    max: 25,
  });
  const preCourse: CourseEntry = {
    instanceId: 'pre-10',
    id: '10',
    code: 'CMSC 165',
    units: 3,
    canEnrollMultiple: false,
    isPreEnlisted: true,
    requiredComponents: ['LEC'],
    sections: [
      {
        section: preSec,
        flags: { isHidden: false, isLocked: false, isStarred: false },
        isPreEnlisted: true,
      },
    ],
    isExpanded: true,
  };

  const lecA = section('LEC-A', '20', 'A', 'LEC', [slot(['Monday', 'Wednesday'], 480, 540)]);
  const labA1 = section('LAB-A1', '20', 'A-1L', 'LAB', [slot(['Wednesday'], 600, 720)], {
    parentClass: lecA,
  });
  const lecB = section('LEC-B', '20', 'B', 'LEC', [slot(['Tuesday'], 420, 480)]); // overlaps PRE-1
  const labB1 = section('LAB-B1', '20', 'B-1L', 'LAB', [slot(['Thursday'], 780, 900)], {
    parentClass: lecB,
  });
  const labFull = section('LAB-FULL', '20', 'A-2L', 'LAB', [slot(['Friday'], 600, 720)], {
    active: 25,
    max: 25,
    parentClass: lecA,
  });

  const intended: CourseEntry = {
    instanceId: 'int-20',
    id: '20',
    code: 'CMSC 128',
    units: 3,
    canEnrollMultiple: false,
    isPreEnlisted: false,
    requiredComponents: ['LEC', 'LAB'],
    sections: [
      {
        section: labA1,
        flags: { isHidden: false, isLocked: false, isStarred: false },
        isPreEnlisted: false,
      },
      {
        section: labB1,
        flags: { isHidden: true, isLocked: false, isStarred: false },
        isPreEnlisted: false,
      },
      {
        section: labFull,
        flags: { isHidden: false, isLocked: false, isStarred: false },
        isPreEnlisted: false,
      },
    ],
    isExpanded: true,
  };

  plan.preEnlistedCourses = [preCourse];
  plan.intendedCourses = [intended];
  plan.blockedCells = [
    { id: 'Thursday:780-840', day: 'Thursday', startMinutes: 780, endMinutes: 840 },
  ];
  plan.unitLimits = { minUnits: 3, maxUnits: 6 };

  return plan;
}

describe('Independent Schedule Validity Rate (SVR) Validator', () => {
  it('validates a clean schedule with 100% SVR', () => {
    const plan = buildSamplePlan();
    const result = validateScheduleAlternative(plan, makeAlt(['PRE-1', 'LEC-A', 'LAB-A1']));
    assert.equal(result.valid, true);
    assert.deepEqual(result.violations, []);
  });

  it('catches overlaps, broken parent-child linkage, hidden, blocked, full, and missing pre-enlisted violations', () => {
    const plan = buildSamplePlan();

    // Missing pre-enlisted + broken parent linkage (LEC-A paired with LAB-B1, which is hidden & blocked!)
    const bad1 = validateScheduleAlternative(plan, makeAlt(['LEC-A', 'LAB-B1']));
    assert.equal(bad1.valid, false);
    const codes1 = new Set(bad1.violations.map((v) => v.code));
    assert.ok(codes1.has('MISSING_PRE_ENLISTED'));
    assert.ok(codes1.has('BROKEN_PARENT_LINKAGE'));
    assert.ok(codes1.has('HIDDEN_SECTION_SELECTED'));
    assert.ok(codes1.has('BLOCKED_TIME_VIOLATION'));

    // Time overlap between PRE-1 and LEC-B
    const bad2 = validateScheduleAlternative(plan, makeAlt(['PRE-1', 'LEC-B', 'LAB-B1']));
    assert.equal(bad2.valid, false);
    assert.ok(bad2.violations.some((v) => v.code === 'TIME_OVERLAP'));

    // Capacity exceeded on non-pre-enlisted LAB-FULL
    const bad3 = validateScheduleAlternative(plan, makeAlt(['PRE-1', 'LEC-A', 'LAB-FULL']));
    assert.equal(bad3.valid, false);
    assert.ok(bad3.violations.some((v) => v.code === 'CAPACITY_EXCEEDED'));

    // Unit limit violation
    const badUnits = validateScheduleAlternative(plan, makeAlt(['PRE-1', 'LEC-A', 'LAB-A1']), {
      maxUnits: 4,
    });
    assert.equal(badUnits.valid, false);
    assert.ok(badUnits.violations.some((v) => v.code === 'UNIT_LIMIT_VIOLATION'));
  });

  it('achieves 100% SVR and fast (< 5.0s) solving on a realistic 5-course Medium-tier scenario', async () => {
    const plan = createDefaultAcademicPlanState();

    // 1 pre-enlisted LEC+LAB course + 4 intended multi-section courses (total 5 courses, ~32 decision vars)
    const preLec = section('P-L', '1', 'S', 'LEC', [slot(['Tuesday', 'Thursday'], 420, 480)], {
      active: 30,
      max: 30,
    });
    const preLab = section('P-B', '1', 'S-1L', 'LAB', [slot(['Friday'], 420, 600)], {
      active: 30,
      max: 30,
      parentClass: preLec,
    });
    plan.preEnlistedCourses = [
      {
        instanceId: 'c-1',
        id: '1',
        code: 'CMSC 165',
        units: 3,
        canEnrollMultiple: false,
        isPreEnlisted: true,
        requiredComponents: ['LEC', 'LAB'],
        sections: [
          {
            section: preLab,
            flags: { isHidden: false, isLocked: false, isStarred: false },
            isPreEnlisted: true,
          },
        ],
        isExpanded: true,
      },
    ];

    const buildPairedCourse = (
      id: string,
      code: string,
      lecSlots: Array<[Weekday[], number, number]>,
      labSlots: Array<[Weekday[], number, number]>
    ): CourseEntry => {
      const options: CourseEntry['sections'] = [];
      for (let i = 0; i < lecSlots.length; i++) {
        const [lDays, lStart, lEnd] = lecSlots[i];
        const lec = section(`${id}-L${i}`, id, `S${i}`, 'LEC', [slot(lDays, lStart, lEnd)]);
        for (let j = 0; j < 2; j++) {
          const [bDays, bStart, bEnd] = labSlots[(i * 2 + j) % labSlots.length];
          const lab = section(`${id}-B${i}-${j}`, id, `S${i}-${j + 1}L`, 'LAB', [
            slot(bDays, bStart, bEnd),
          ], { parentClass: lec });
          options.push({
            section: lab,
            flags: { isHidden: false, isLocked: false, isStarred: i === 0 && j === 0 },
            isPreEnlisted: false,
          });
        }
      }
      return {
        instanceId: `c-${id}`,
        id,
        code,
        units: 3,
        canEnrollMultiple: false,
        isPreEnlisted: false,
        requiredComponents: ['LEC', 'LAB'],
        sections: options,
        isExpanded: true,
      };
    };

    plan.intendedCourses = [
      buildPairedCourse(
        '2',
        'CMSC 128',
        [
          [['Tuesday', 'Thursday'], 540, 600],
          [['Monday', 'Wednesday'], 480, 540],
        ],
        [
          [['Monday'], 780, 960],
          [['Wednesday'], 780, 960],
          [['Thursday'], 600, 780],
          [['Tuesday'], 600, 780],
        ]
      ),
      buildPairedCourse(
        '3',
        'CMSC 132',
        [
          [['Monday', 'Wednesday'], 600, 660],
          [['Tuesday', 'Thursday'], 600, 660],
        ],
        [
          [['Tuesday'], 840, 1020],
          [['Thursday'], 840, 1020],
          [['Friday'], 660, 840],
          [['Monday'], 540, 720],
        ]
      ),
      {
        instanceId: 'c-4',
        id: '4',
        code: 'STAT 1',
        units: 3,
        canEnrollMultiple: false,
        isPreEnlisted: false,
        requiredComponents: ['LEC'],
        sections: [
          {
            section: section('4-1', '4', 'A', 'LEC', [slot(['Monday', 'Wednesday'], 660, 750)]),
            flags: { isHidden: false, isLocked: false, isStarred: false },
            isPreEnlisted: false,
          },
          {
            section: section('4-2', '4', 'B', 'LEC', [slot(['Tuesday', 'Thursday'], 660, 750)]),
            flags: { isHidden: false, isLocked: false, isStarred: true },
            isPreEnlisted: false,
          },
          {
            section: section('4-3', '4', 'C', 'LEC', [slot(['Friday'], 840, 1020)]),
            flags: { isHidden: false, isLocked: false, isStarred: false },
            isPreEnlisted: false,
          },
        ],
        isExpanded: true,
      },
      {
        instanceId: 'c-5',
        id: '5',
        code: 'ETHICS 1',
        units: 3,
        canEnrollMultiple: false,
        isPreEnlisted: false,
        requiredComponents: ['LEC'],
        sections: [
          {
            section: section('5-1', '5', 'U', 'LEC', [slot(['Tuesday', 'Thursday'], 480, 540)]),
            flags: { isHidden: false, isLocked: false, isStarred: false },
            isPreEnlisted: false,
          },
          {
            section: section('5-2', '5', 'V', 'LEC', [slot(['Monday', 'Wednesday'], 540, 600)]),
            flags: { isHidden: false, isLocked: false, isStarred: false },
            isPreEnlisted: false,
          },
          {
            section: section('5-3', '5', 'W', 'LEC', [slot(['Monday', 'Wednesday'], 960, 1050)]),
            flags: { isHidden: false, isLocked: false, isStarred: false },
            isPreEnlisted: false,
          },
        ],
        isExpanded: true,
      },
    ];

    plan.blockedCells = [
      { id: 'Wednesday:960-1020', day: 'Wednesday', startMinutes: 960, endMinutes: 1020 },
    ];
    plan.unitLimits = { minUnits: 12, maxUnits: 18 };

    const res = await solveAcademicPlan(plan);
    assert.ok(res.status === 'OPTIMAL' || res.status === 'FEASIBLE');
    assert.equal(res.alternatives.length, 3);
    assert.ok(
      res.timing.solverExecutionMs < 5000,
      `Expected solver execution < 5000ms, got ${res.timing.solverExecutionMs}ms`
    );

    const svr = computeScheduleValidityRate(plan, res.alternatives);
    assert.equal(svr.scheduleValidityRate, 1);
    assert.equal(svr.validSchedules, 3);
  });
});
