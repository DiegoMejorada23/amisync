import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyRelaxationToPlan,
  buildForegroundConstraints,
  createQuickXplainBudget,
  diagnoseAcademicPlan,
  findMinimalConflict,
  mergeContiguousBlockedCells,
  preprocessAcademicPlan,
  quickXplain,
  solveAcademicPlan,
  validateScheduleAlternative,
  verifyMusProperties,
} from '../src/solver/index.ts';
import {
  createDefaultAcademicPlanState,
  type AcademicPlanState,
  type BlockedTimeCell,
  type CourseEntry,
  type CourseSectionOption,
  type NormalizedSection,
  type SectionUserFlags,
  type TimeslotInterval,
  type Weekday,
} from '../src/types/domain.ts';

function makeSlot(days: Weekday[], startMinutes: number, endMinutes: number): TimeslotInterval {
  const fmt = (mins: number) => {
    const h24 = Math.floor(mins / 60);
    const m = mins % 60;
    const meridiem = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${meridiem}`;
  };
  return {
    days,
    startTime: fmt(startMinutes),
    endTime: fmt(endMinutes),
    startMinutes,
    endMinutes,
  };
}

function makeSection(params: {
  id: string;
  courseId: string;
  section: string;
  activity: string | null;
  dates: TimeslotInterval[];
  activeClassSize?: number;
  maxClassSize?: number;
  parentClass?: NormalizedSection | null;
  parentClassId?: string | null;
}): NormalizedSection {
  return {
    id: params.id,
    courseId: params.courseId,
    section: params.section,
    activity: params.activity,
    faculties: [],
    location: 'ICS LH3',
    dates: params.dates,
    activeClassSize: params.activeClassSize ?? 10,
    maxClassSize: params.maxClassSize ?? 30,
    isPrerogOpen: false,
    parentClassId: params.parentClass ? params.parentClass.id : (params.parentClassId ?? null),
    parentClass: params.parentClass ?? null,
  };
}

function makeOption(
  section: NormalizedSection,
  overrides: { flags?: Partial<SectionUserFlags>; isPreEnlisted?: boolean } = {}
): CourseSectionOption {
  return {
    section,
    flags: {
      isHidden: overrides.flags?.isHidden ?? false,
      isLocked: overrides.flags?.isLocked ?? false,
      isStarred: overrides.flags?.isStarred ?? false,
    },
    isPreEnlisted: overrides.isPreEnlisted ?? false,
  };
}

function makeCourse(params: {
  id: string;
  code: string;
  units?: number;
  isPreEnlisted?: boolean;
  requiredComponents?: string[];
  sections: CourseSectionOption[];
}): CourseEntry {
  return {
    instanceId: `qx-inst-${params.id}-${params.isPreEnlisted ? 'pre' : 'int'}`,
    id: params.id,
    code: params.code,
    units: params.units ?? 3,
    canEnrollMultiple: false,
    isPreEnlisted: params.isPreEnlisted ?? false,
    requiredComponents: params.requiredComponents ?? [],
    sections: params.sections,
    isExpanded: true,
  };
}

function makeHourlyBlocks(day: Weekday, startHour: number, endHour: number): BlockedTimeCell[] {
  const cells: BlockedTimeCell[] = [];
  for (let h = startHour; h < endHour; h++) {
    const startMinutes = h * 60;
    const endMinutes = (h + 1) * 60;
    cells.push({
      id: `${day}:${startMinutes}-${endMinutes}`,
      day,
      startMinutes,
      endMinutes,
    });
  }
  return cells;
}

function makePlan(overrides: Partial<AcademicPlanState> = {}): AcademicPlanState {
  const base = createDefaultAcademicPlanState();
  return {
    ...base,
    ...overrides,
  };
}

describe('Core Recursive QuickXplain Algorithm (Junker, 2004)', () => {
  it('isolates exact unique MUS and respects preference priority order when multiple MUSes exist', async () => {
    // Abstract oracle:
    // {c1, c2} is UNSAT, {c1, c3} is UNSAT, {c4} is irrelevant.
    const oracle = (subset: readonly string[]) => {
      const s = new Set(subset);
      if (s.has('c1') && s.has('c2')) return false;
      if (s.has('c1') && s.has('c3')) return false;
      return true;
    };

    // Priority order 1: c1 > c2 > c3 > c4 => must isolate {c1, c2}
    const res1 = await findMinimalConflict<string>(
      [],
      ['c1', 'c2', 'c3', 'c4'],
      oracle,
      createQuickXplainBudget(),
      (x) => x
    );
    assert.equal(res1.status, 'MUS_FOUND');
    assert.deepEqual(res1.mus, ['c1', 'c2']);

    // Priority order 2: c1 > c3 > c2 > c4 => must isolate {c1, c3}
    const res2 = await quickXplain<string>(
      [],
      ['c1', 'c3', 'c2', 'c4'],
      oracle,
      createQuickXplainBudget(),
      (x) => x
    );
    assert.equal(res2.status, 'MUS_FOUND');
    assert.deepEqual(res2.mus, ['c1', 'c3']);
  });

  it('detects BACKGROUND_INCONSISTENT when B alone is unsatisfiable and CONSISTENT when B ∪ C is satisfiable', async () => {
    const bgInconsistent = await quickXplain<string>(
      ['b_bad'],
      ['c1', 'c2'],
      (subset) => !subset.includes('b_bad'),
      createQuickXplainBudget(),
      (x) => x
    );
    assert.equal(bgInconsistent.status, 'BACKGROUND_INCONSISTENT');
    assert.deepEqual(bgInconsistent.mus, []);

    const consistent = await quickXplain<string>(
      ['b_ok'],
      ['c1', 'c2'],
      () => true,
      createQuickXplainBudget(),
      (x) => x
    );
    assert.equal(consistent.status, 'CONSISTENT');
    assert.deepEqual(consistent.mus, []);
  });

  it('merges contiguous blocked cells on the same weekday while keeping non-contiguous windows separate', () => {
    const cells: BlockedTimeCell[] = [
      ...makeHourlyBlocks('Tuesday', 13, 16), // Tue 1-4 PM
      ...makeHourlyBlocks('Tuesday', 8, 9),   // Tue 8-9 AM (separate)
      ...makeHourlyBlocks('Thursday', 13, 16), // Thu 1-4 PM
    ];

    const merged = mergeContiguousBlockedCells(cells);
    assert.equal(merged.length, 3);
    assert.equal(merged[0].id, 'Tuesday:480-540');
    assert.equal(merged[1].id, 'Tuesday:780-960');
    assert.equal(merged[1].sourceCellIds.length, 3);
    assert.equal(merged[2].id, 'Thursday:780-960');
  });
});

describe('Hard Structural Conflicts (Unresolvable by Relaxing User Preferences)', () => {
  it('flags Tier 1 DATA_INCONSISTENCY when two mandatory pre-enlisted courses overlap in Background Set B', async () => {
    const pre1 = makeCourse({
      id: '165',
      code: 'CMSC 165',
      isPreEnlisted: true,
      sections: [
        makeOption(
          makeSection({
            id: '165-S',
            courseId: '165',
            section: 'S',
            activity: 'LEC',
            dates: [makeSlot(['Tuesday', 'Thursday'], 540, 630)], // 9:00-10:30 AM
          }),
          { isPreEnlisted: true }
        ),
      ],
    });
    const pre2 = makeCourse({
      id: '170',
      code: 'CMSC 170',
      isPreEnlisted: true,
      sections: [
        makeOption(
          makeSection({
            id: '170-A',
            courseId: '170',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Tuesday', 'Thursday'], 600, 690)], // 10:00-11:30 AM (overlaps!)
          }),
          { isPreEnlisted: true }
        ),
      ],
    });
    const elective = makeCourse({
      id: '10',
      code: 'ETHICS 1',
      sections: [
        makeOption(
          makeSection({
            id: '10-A',
            courseId: '10',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Wednesday'], 780, 840)],
          })
        ),
      ],
    });

    const plan = makePlan({
      preEnlistedCourses: [pre1, pre2],
      intendedCourses: [elective],
      blockedCells: makeHourlyBlocks('Monday', 7, 10),
    });

    const res = await solveAcademicPlan(plan);
    assert.equal(res.status, 'INFEASIBLE');
    assert.ok(res.diagnosis);
    assert.equal(res.diagnosis.origin, 'DATA_INCONSISTENCY');
    assert.equal(res.diagnosis.isStructuralConflict, true);
    assert.deepEqual(res.diagnosis.mus, []);
    assert.deepEqual(res.diagnosis.affectedCourseCodes.sort(), ['CMSC 165', 'CMSC 170']);
    assert.match(res.diagnosis.conflictSummaryBullets[0], /CMSC 165.*CMSC 170/);
    assert.deepEqual(res.diagnosis.fallbackOptions, []);
  });

  it('isolates exact 2-course structural conflict even when unrelated user time blocks and hidden sections exist', async () => {
    // Two required intended courses whose ONLY available sections overlap on Monday 10:00-11:30 / 10:30-12:00.
    const cmsc141 = makeCourse({
      id: '141',
      code: 'CMSC 141',
      sections: [
        makeOption(
          makeSection({
            id: '141-A',
            courseId: '141',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday', 'Wednesday'], 600, 690)],
          })
        ),
      ],
    });
    const cmsc142 = makeCourse({
      id: '142',
      code: 'CMSC 142',
      sections: [
        makeOption(
          makeSection({
            id: '142-A',
            courseId: '142',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday', 'Wednesday'], 630, 720)],
          })
        ),
      ],
    });
    // Third non-conflicting course with a hidden section + a Friday free-day block
    const stat1 = makeCourse({
      id: '201',
      code: 'STAT 1',
      sections: [
        makeOption(
          makeSection({
            id: '201-A',
            courseId: '201',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Tuesday'], 600, 660)],
          })
        ),
        makeOption(
          makeSection({
            id: '201-B',
            courseId: '201',
            section: 'B',
            activity: 'LEC',
            dates: [makeSlot(['Friday'], 600, 660)],
          }),
          { flags: { isHidden: true } }
        ),
      ],
    });

    const plan = makePlan({
      intendedCourses: [cmsc141, cmsc142, stat1],
      blockedCells: makeHourlyBlocks('Friday', 7, 19),
    });

    const res = await solveAcademicPlan(plan);
    assert.equal(res.status, 'INFEASIBLE');
    assert.ok(res.diagnosis);
    assert.equal(res.diagnosis.origin, 'PREFERENCE_CONFLICT');
    assert.equal(res.diagnosis.isStructuralConflict, true);

    // MUS must contain ONLY CMSC 141 and CMSC 142 — NOT STAT 1, NOT Friday block, NOT hidden 201-B!
    assert.equal(res.diagnosis.mus.length, 2);
    assert.ok(res.diagnosis.mus.every((c) => c.kind === 'INTENDED_COURSE'));
    assert.deepEqual(
      res.diagnosis.mus.map((c) => (c.kind === 'INTENDED_COURSE' ? c.courseCode : '')).sort(),
      ['CMSC 141', 'CMSC 142']
    );
    assert.match(
      res.diagnosis.conflictSummaryBullets[0],
      /Course overlap conflict: All available sections of CMSC 141 clash directly with CMSC 142\./
    );

    // Independently verify relaxing ALL user preferences (time blocks & hidden sections) STILL cannot resolve it!
    const preferencesClearedPlan: AcademicPlanState = {
      ...plan,
      blockedCells: [],
      intendedCourses: plan.intendedCourses.map((c) => ({
        ...c,
        sections: c.sections.map((opt) => ({
          ...opt,
          flags: { isHidden: false, isLocked: false, isStarred: opt.flags.isStarred },
        })),
      })),
    };
    const stillInfeasible = await solveAcademicPlan(preferencesClearedPlan, {
      skipDiagnosis: true,
    });
    assert.equal(stillInfeasible.status, 'INFEASIBLE');

    // Verify mathematical MUS properties (unsatisfiability + irreducibility)
    const problem = preprocessAcademicPlan(plan);
    const allForeground = buildForegroundConstraints(problem, plan);
    const musItems = allForeground.filter((item) =>
      res.diagnosis!.mus.some(
        (m) => m.kind === 'INTENDED_COURSE' && item.ref.kind === 'INTENDED_COURSE' && m.courseId === item.ref.courseId
      )
    );
    const verification = await verifyMusProperties(problem, musItems);
    assert.equal(verification.isValidMus, true);
    assert.equal(verification.isUnsatisfiable, true);
    assert.equal(verification.isIrreducible, true);

    // Fallback options must offer dropping either CMSC 141 or CMSC 142 and yield valid schedules
    assert.ok((res.diagnosis.fallbackOptions?.length ?? 0) === 2);
    for (const fb of res.diagnosis.fallbackOptions!) {
      assert.equal(fb.relaxation.actionType, 'DROP_OR_REPLACE_COURSE');
      assert.equal(fb.schedule.status, 'OPTIMAL');
      const relaxed = applyRelaxationToPlan(plan, fb.relaxation);
      assert.equal(validateScheduleAlternative(relaxed, fb.schedule).valid, true);
    }
  });
});

describe('Preference-Induced Infeasibility, Priority Ordering & Thesis 2.0.png EMR', () => {
  it('achieves exact MUS match (EMR = 100%) on the full Paper Files/2.0.png scenario with distractor courses', async () => {
    const preLec = makeSection({
      id: '165-S',
      courseId: '165',
      section: 'S',
      activity: 'LEC',
      dates: [makeSlot(['Tuesday', 'Thursday'], 420, 480)],
    });
    const preLab = makeSection({
      id: '165-S4L',
      courseId: '165',
      section: 'S-4L',
      activity: 'LAB',
      dates: [makeSlot(['Friday'], 420, 600)],
      parentClass: preLec,
    });
    const cmsc165 = makeCourse({
      id: '165',
      code: 'CMSC 165',
      isPreEnlisted: true,
      requiredComponents: ['LEC', 'LAB'],
      sections: [makeOption(preLab, { isPreEnlisted: true })],
    });

    const lecAB = makeSection({
      id: '128-AB',
      courseId: '128',
      section: 'AB',
      activity: 'LEC',
      dates: [makeSlot(['Tuesday', 'Thursday'], 480, 540)],
    });
    const lecCD = makeSection({
      id: '128-CD',
      courseId: '128',
      section: 'CD',
      activity: 'LEC',
      dates: [makeSlot(['Tuesday', 'Thursday'], 480, 540)],
    });
    const cmsc128 = makeCourse({
      id: '128',
      code: 'CMSC 128',
      requiredComponents: ['LEC', 'LAB'],
      sections: [
        makeOption(
          makeSection({
            id: '128-AB1L',
            courseId: '128',
            section: 'AB-1L',
            activity: 'LAB',
            dates: [makeSlot(['Thursday'], 780, 960)], // Thu 1-4 PM
            parentClass: lecAB,
          })
        ),
        makeOption(
          makeSection({
            id: '128-CD2L',
            courseId: '128',
            section: 'CD-2L',
            activity: 'LAB',
            dates: [makeSlot(['Tuesday'], 780, 960)], // Tue 1-4 PM
            parentClass: lecCD,
          })
        ),
      ],
    });

    // Distractor non-conflicting courses shown in Paper Files/2.0.png
    const stat1 = makeCourse({
      id: '201',
      code: 'STAT 1',
      sections: [
        makeOption(
          makeSection({
            id: '201-A',
            courseId: '201',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday', 'Wednesday'], 540, 630)],
          })
        ),
      ],
    });
    const ethics1 = makeCourse({
      id: '301',
      code: 'ETHICS 1',
      sections: [
        makeOption(
          makeSection({
            id: '301-A',
            courseId: '301',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday', 'Wednesday'], 660, 750)],
          })
        ),
      ],
    });

    const plan = makePlan({
      preEnlistedCourses: [cmsc165],
      intendedCourses: [cmsc128, stat1, ethics1],
      blockedCells: [
        ...makeHourlyBlocks('Tuesday', 13, 16),
        ...makeHourlyBlocks('Thursday', 13, 16),
        // Distractor non-conflicting block on Saturday morning
        ...makeHourlyBlocks('Saturday', 7, 9),
      ],
    });

    const res = await solveAcademicPlan(plan);
    assert.equal(res.status, 'INFEASIBLE');
    assert.ok(res.diagnosis);
    assert.equal(res.diagnosis.origin, 'PREFERENCE_CONFLICT');
    assert.equal(res.diagnosis.isStructuralConflict, false);

    // Exact 3-element MUS matching SPEC.md Section 6.4 (excludes STAT 1, ETHICS 1, Saturday block)
    assert.equal(res.diagnosis.mus.length, 3);
    const musKinds = res.diagnosis.mus.map((m) =>
      m.kind === 'INTENDED_COURSE'
        ? `COURSE:${m.courseCode}`
        : m.kind === 'TIME_BLOCK'
          ? `BLOCK:${m.blockId}`
          : m.kind
    ).sort();
    assert.deepEqual(musKinds, [
      'BLOCK:Thursday:780-960',
      'BLOCK:Tuesday:780-960',
      'COURSE:CMSC 128',
    ]);

    assert.equal(
      res.diagnosis.conflictSummaryBullets[0],
      'Tue/Thu block conflict: Your blocked hours on Tue/Thu clash directly with the only available sections of CMSC 128.'
    );
    assert.equal(
      res.diagnosis.relaxationSuggestions[0],
      'Consider unblocking 1:00 PM - 4:00 PM or searching for alternative elective courses.'
    );
    assert.deepEqual(res.diagnosis.affectedCourseCodes, ['CMSC 128']);

    // Verify mathematical MUS properties (unsatisfiability + irreducibility)
    const problem = preprocessAcademicPlan(plan);
    const allForeground = buildForegroundConstraints(problem, plan);
    const musItems = allForeground.filter((item) =>
      res.diagnosis!.mus.some((m) =>
        m.kind === 'INTENDED_COURSE'
          ? item.ref.kind === 'INTENDED_COURSE' && item.ref.courseId === m.courseId
          : m.kind === 'TIME_BLOCK'
            ? item.ref.kind === 'TIME_BLOCK' && item.ref.blockId === m.blockId
            : false
      )
    );
    const check = await verifyMusProperties(problem, musItems);
    assert.equal(check.isValidMus, true);

    // Verify relaxing the first diagnosed time-block action yields a feasible optimal schedule with 100% SVR!
    const unblockAction = res.diagnosis.relaxationActions?.find(
      (a) => a.actionType === 'UNBLOCK_TIME_WINDOW'
    );
    assert.ok(unblockAction);
    const relaxedPlan = applyRelaxationToPlan(plan, unblockAction);
    const resolved = await solveAcademicPlan(relaxedPlan);
    assert.equal(resolved.status, 'OPTIMAL');
    assert.equal(resolved.diagnosis, null);
    assert.ok(resolved.alternatives.length >= 1);
    assert.equal(validateScheduleAlternative(relaxedPlan, resolved.alternatives[0]).valid, true);
  });

  it('respects preference priority order across conflicting free-day, time-window, hidden, and locked constraints', async () => {
    // Course CMSC 132 has 3 sections:
    //  - 132-FRI: Friday 10-11 AM (conflicts with Friday free-day block AND hidden flag!)
    //  - 132-EARLY: Monday 7-8 AM (conflicts with early-morning preferred-window block)
    //  - 132-TUE: Tuesday 2-3 PM (overlaps with locked section 135-LOCK!)
    const cmsc132 = makeCourse({
      id: '132',
      code: 'CMSC 132',
      sections: [
        makeOption(
          makeSection({
            id: '132-FRI',
            courseId: '132',
            section: 'F1',
            activity: 'LEC',
            dates: [makeSlot(['Friday'], 600, 660)],
          }),
          { flags: { isHidden: true } }
        ),
        makeOption(
          makeSection({
            id: '132-EARLY',
            courseId: '132',
            section: 'M1',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 420, 480)],
          })
        ),
        makeOption(
          makeSection({
            id: '132-TUE',
            courseId: '132',
            section: 'T1',
            activity: 'LEC',
            dates: [makeSlot(['Tuesday'], 840, 900)],
          })
        ),
      ],
    });

    // Course CMSC 135 has 2 sections:
    //  - 135-LOCK: Tuesday 2-3 PM (USER LOCKED -> clashes with 132-TUE!)
    //  - 135-ALT: Wednesday 2-3 PM (alternative available if unlocked)
    const cmsc135 = makeCourse({
      id: '135',
      code: 'CMSC 135',
      sections: [
        makeOption(
          makeSection({
            id: '135-LOCK',
            courseId: '135',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Tuesday'], 840, 900)],
          }),
          { flags: { isLocked: true } }
        ),
        makeOption(
          makeSection({
            id: '135-ALT',
            courseId: '135',
            section: 'B',
            activity: 'LEC',
            dates: [makeSlot(['Wednesday'], 840, 900)],
          })
        ),
      ],
    });

    // Notice there are TWO distinct minimal explanations for why 132-FRI is excluded:
    //   MUS_A uses Friday free-day block (`Friday:420-1140`)
    //   MUS_B uses hidden section (`132-FRI`)
    // Together with {INTENDED_COURSE(CMSC 132), USER_LOCKED_SECTION(135-LOCK), TIME_BLOCK(Monday:420-540)}!
    const plan = makePlan({
      intendedCourses: [cmsc132, cmsc135],
      blockedCells: [
        ...makeHourlyBlocks('Friday', 7, 19),  // Free-day block on Friday
        ...makeHourlyBlocks('Monday', 7, 9),   // Preferred morning window block (7-9 AM)
      ],
    });

    // Ordering 1 (Default): Friday free-day block (priority 65) > Hidden section 132-FRI (priority 40)
    // => QuickXplain must isolate the Friday block (NOT the hidden section) alongside CMSC 132, 135-LOCK, and Mon 7-9 AM!
    const diag1 = await diagnoseAcademicPlan(plan);
    assert.equal(diag1.isFeasible, false);
    assert.ok(diag1.diagnosis);
    const mus1Keys = diag1.diagnosis.mus
      .map((m) =>
        m.kind === 'INTENDED_COURSE'
          ? `COURSE:${m.courseCode}`
          : m.kind === 'TIME_BLOCK'
            ? `BLOCK:${m.blockId}`
            : `${m.kind}:${m.sectionId}`
      )
      .sort();
    assert.deepEqual(mus1Keys, [
      'BLOCK:Friday:420-1140',
      'BLOCK:Monday:420-540',
      'COURSE:CMSC 132',
      'USER_LOCKED_SECTION:135-LOCK',
    ]);

    // Ordering 2 (Custom priority): Elevate HIDDEN_SECTION(132-FRI) priority to 90 > Friday block priority 20
    // => QuickXplain must now deterministically isolate HIDDEN_SECTION(132-FRI) instead of the Friday block!
    const diag2 = await diagnoseAcademicPlan(plan, {
      constraintPriorities: {
        'HIDDEN_SECTION:132-FRI': 90,
        'Friday:420-1140': 20,
      },
    });
    assert.equal(diag2.isFeasible, false);
    assert.ok(diag2.diagnosis);
    const mus2Keys = diag2.diagnosis.mus
      .map((m) =>
        m.kind === 'INTENDED_COURSE'
          ? `COURSE:${m.courseCode}`
          : m.kind === 'TIME_BLOCK'
            ? `BLOCK:${m.blockId}`
            : `${m.kind}:${m.sectionId}`
      )
      .sort();
    assert.deepEqual(mus2Keys, [
      'BLOCK:Monday:420-540',
      'COURSE:CMSC 132',
      'HIDDEN_SECTION:132-FRI',
      'USER_LOCKED_SECTION:135-LOCK',
    ]);

    // Verify unlocking the diagnosed locked section 135-LOCK (from either MUS) immediately restores an OPTIMAL schedule!
    const unlockAction = diag1.diagnosis.relaxationActions?.find(
      (a) => a.actionType === 'UNLOCK_SECTION'
    );
    assert.ok(unlockAction);
    const relaxedPlan = applyRelaxationToPlan(plan, unlockAction);
    const solved = await solveAcademicPlan(relaxedPlan);
    assert.equal(solved.status, 'OPTIMAL');
    assert.equal(solved.diagnosis, null);
    assert.ok(solved.alternatives[0].selectedSectionIds.includes('132-TUE'));
    assert.ok(solved.alternatives[0].selectedSectionIds.includes('135-ALT'));
    assert.equal(validateScheduleAlternative(relaxedPlan, solved.alternatives[0]).valid, true);
  });

  it('produces exact Pre-enlisted lock conflict explanation when an intended course overlaps a pre-enlisted anchor', async () => {
    const pre = makeCourse({
      id: '165',
      code: 'CMSC 165',
      isPreEnlisted: true,
      sections: [
        makeOption(
          makeSection({
            id: '165-S',
            courseId: '165',
            section: 'S',
            activity: 'LEC',
            dates: [makeSlot(['Tuesday', 'Thursday'], 420, 480)],
          }),
          { isPreEnlisted: true }
        ),
      ],
    });
    const intended = makeCourse({
      id: '250',
      code: 'PI 10',
      sections: [
        makeOption(
          makeSection({
            id: '250-A',
            courseId: '250',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Tuesday', 'Thursday'], 420, 480)],
          })
        ),
      ],
    });

    const res = await solveAcademicPlan(
      makePlan({ preEnlistedCourses: [pre], intendedCourses: [intended] })
    );
    assert.equal(res.status, 'INFEASIBLE');
    assert.ok(res.diagnosis);
    assert.equal(res.diagnosis.origin, 'PREFERENCE_CONFLICT');
    assert.equal(res.diagnosis.mus.length, 1);
    assert.equal(res.diagnosis.mus[0].kind, 'INTENDED_COURSE');
    assert.equal(
      res.diagnosis.conflictSummaryBullets[0],
      'Pre-enlisted lock conflict: Your locked course CMSC 165 (S) overlaps with all available sections of PI 10.'
    );
    assert.equal(
      res.diagnosis.relaxationSuggestions[0],
      'Consider searching for an alternative course to replace PI 10.'
    );
  });

  it('produces exact Section exclusion conflict explanation and recovers feasibility on unhide', async () => {
    const arts = makeCourse({
      id: '310',
      code: 'ARTS 1',
      sections: [
        makeOption(
          makeSection({
            id: '310-A',
            courseId: '310',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Wednesday'], 600, 660)],
          }),
          { flags: { isHidden: true } }
        ),
      ],
    });

    const plan = makePlan({ intendedCourses: [arts] });
    const res = await solveAcademicPlan(plan);
    assert.equal(res.status, 'INFEASIBLE');
    assert.ok(res.diagnosis);
    assert.equal(res.diagnosis.origin, 'PREFERENCE_CONFLICT');
    assert.match(res.diagnosis.conflictSummaryBullets[0], /^Section exclusion conflict:/);

    const unhideAction = res.diagnosis.relaxationActions?.find(
      (a) => a.actionType === 'UNHIDE_SECTION'
    );
    assert.ok(unhideAction);
    const resolved = await solveAcademicPlan(applyRelaxationToPlan(plan, unhideAction));
    assert.equal(resolved.status, 'OPTIMAL');
    assert.deepEqual(resolved.alternatives[0].selectedSectionIds, ['310-A']);
  });

  it('gracefully falls back to SOLVER_RESOURCE_FALLBACK when consistency-check budget is exhausted', async () => {
    const c1 = makeCourse({
      id: '501',
      code: 'CMSC 141',
      sections: [
        makeOption(
          makeSection({
            id: '501-A',
            courseId: '501',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 600, 660)],
          })
        ),
      ],
    });
    const c2 = makeCourse({
      id: '502',
      code: 'CMSC 142',
      sections: [
        makeOption(
          makeSection({
            id: '502-A',
            courseId: '502',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 600, 660)],
          })
        ),
      ],
    });

    const diag = await diagnoseAcademicPlan(
      makePlan({ intendedCourses: [c1, c2] }),
      { maxConsistencyChecks: 1 }
    );
    assert.equal(diag.isFeasible, false);
    assert.ok(diag.diagnosis);
    assert.equal(diag.diagnosis.origin, 'SOLVER_RESOURCE_FALLBACK');
    assert.equal(
      diag.diagnosis.conflictSummaryBullets[0],
      'Model infeasible: Unable to isolate a minimal conflict set within browser memory/time limits.'
    );
    assert.equal(
      diag.diagnosis.relaxationSuggestions[0],
      'Manually remove blocked time slots or deselect a course to restore feasibility.'
    );
  });
});
