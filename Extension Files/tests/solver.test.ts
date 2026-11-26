import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCourseEntryFromRaw } from '../src/amis/parser.ts';
import {
  computeHammingDistance,
  computeScheduleValidityRate,
  evaluateSelectionObjective,
  preprocessAcademicPlan,
  solveAcademicPlan,
  validateScheduleAlternative,
} from '../src/solver/index.ts';
import type { RawAmisClass, RawAmisCourse } from '../src/types/amis.ts';
import {
  createDefaultAcademicPlanState,
  type AcademicPlanState,
  type BlockedTimeCell,
  type CourseEntry,
  type CourseSectionOption,
  type NormalizedSection,
  type SectionUserFlags,
  type StudentPreferences,
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
    instanceId: `inst-${params.id}-${params.isPreEnlisted ? 'pre' : 'int'}`,
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

function allOffPreferences(): StudentPreferences {
  return {
    fatigueLimit: { priority: 'Off', maxConsecutiveHours: 6 },
    acceptableDayBounds: {
      priority: 'Off',
      earliestStartMinutes: 420,
      latestEndMinutes: 1080,
    },
    minimizeFridayClasses: { priority: 'Off' },
    batchSubjectsToFewerDays: { priority: 'Off' },
    minimizeExcessiveGaps: { priority: 'Off', gapThresholdMinutes: 120 },
    starredSectionPreference: { priority: 'Off' },
  };
}

function makePlan(overrides: Partial<AcademicPlanState> = {}): AcademicPlanState {
  const base = createDefaultAcademicPlanState();
  return {
    ...base,
    preferences: overrides.preferences ?? allOffPreferences(),
    diversity: {
      ...base.diversity,
      alternatePreferenceProfiles: false,
      ...(overrides.diversity ?? {}),
    },
    ...overrides,
  };
}

describe('CP-SAT Hard Constraints & Preprocessing', () => {
  it('allows adjacent back-to-back classes (end_i === start_j) while forbidding overlaps', async () => {
    const c1 = makeCourse({
      id: '101',
      code: 'CMSC 12',
      sections: [
        makeOption(
          makeSection({
            id: '101-A',
            courseId: '101',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday', 'Wednesday'], 480, 540)], // 8:00-9:00 AM
          })
        ),
      ],
    });
    const c2 = makeCourse({
      id: '102',
      code: 'MATH 27',
      sections: [
        makeOption(
          makeSection({
            id: '102-OVERLAP',
            courseId: '102',
            section: 'X',
            activity: 'LEC',
            dates: [makeSlot(['Monday', 'Wednesday'], 510, 600)], // 8:30-10:00 AM (overlaps!)
          })
        ),
        makeOption(
          makeSection({
            id: '102-ADJ',
            courseId: '102',
            section: 'Y',
            activity: 'LEC',
            dates: [makeSlot(['Monday', 'Wednesday'], 540, 600)], // 9:00-10:00 AM (adjacent!)
          })
        ),
      ],
    });

    const plan = makePlan({ intendedCourses: [c1, c2] });
    const res = await solveAcademicPlan(plan);

    assert.equal(res.status, 'OPTIMAL');
    assert.equal(res.alternatives.length, 1);
    assert.deepEqual(res.alternatives[0].selectedSectionIds.sort(), ['101-A', '102-ADJ']);
    assert.equal(validateScheduleAlternative(plan, res.alternatives[0]).valid, true);
  });

  it('enforces Lecture + Laboratory paired section co-requisite linkage (nested & flat)', async () => {
    // Course A uses nested parentClass (live AMIS API format):
    // AB (LEC TTh 8-9) -> AB-1L (LAB Th 1-4)
    // CD (LEC TTh 10-11) -> CD-2L (LAB T 1-4)
    const lecAB = makeSection({
      id: 'AB-LEC',
      courseId: '128',
      section: 'AB',
      activity: 'LEC',
      dates: [makeSlot(['Tuesday', 'Thursday'], 480, 540)],
    });
    const lecCD = makeSection({
      id: 'CD-LEC',
      courseId: '128',
      section: 'CD',
      activity: 'LEC',
      dates: [makeSlot(['Tuesday', 'Thursday'], 600, 660)],
    });
    const cmsc128 = makeCourse({
      id: '128',
      code: 'CMSC 128',
      requiredComponents: ['LEC', 'LAB'],
      sections: [
        makeOption(
          makeSection({
            id: 'AB-1L',
            courseId: '128',
            section: 'AB-1L',
            activity: 'LAB',
            dates: [makeSlot(['Thursday'], 780, 960)],
            parentClass: lecAB,
          })
        ),
        makeOption(
          makeSection({
            id: 'CD-2L',
            courseId: '128',
            section: 'CD-2L',
            activity: 'LAB',
            dates: [makeSlot(['Tuesday'], 780, 960)],
            parentClass: lecCD,
          })
        ),
      ],
    });

    // Course B uses flat parentClassId (snapshot format) with BOTH LAB and RECIT linked to LEC!
    const statLec1 = makeSection({
      id: 'STAT-L1',
      courseId: '201',
      section: 'A',
      activity: 'LEC',
      dates: [makeSlot(['Monday', 'Wednesday'], 600, 660)],
    });
    const statLec2 = makeSection({
      id: 'STAT-L2',
      courseId: '201',
      section: 'B',
      activity: 'LEC',
      dates: [makeSlot(['Tuesday', 'Thursday'], 480, 540)], // conflicts with AB-LEC!
    });
    const stat1 = makeCourse({
      id: '201',
      code: 'STAT 1',
      requiredComponents: ['LEC', 'LAB', 'RECIT'],
      sections: [
        makeOption(statLec1),
        makeOption(statLec2),
        makeOption(
          makeSection({
            id: 'STAT-A1L',
            courseId: '201',
            section: 'A-1L',
            activity: 'LAB',
            dates: [makeSlot(['Wednesday'], 780, 900)],
            parentClassId: 'STAT-L1',
          })
        ),
        makeOption(
          makeSection({
            id: 'STAT-A1R',
            courseId: '201',
            section: 'A-1R',
            activity: 'RECIT',
            dates: [makeSlot(['Monday'], 780, 840)],
            parentClassId: 'STAT-L1',
          })
        ),
        makeOption(
          makeSection({
            id: 'STAT-B1L',
            courseId: '201',
            section: 'B-1L',
            activity: 'LAB',
            dates: [makeSlot(['Friday'], 600, 720)],
            parentClassId: 'STAT-L2',
          })
        ),
        makeOption(
          makeSection({
            id: 'STAT-B1R',
            courseId: '201',
            section: 'B-1R',
            activity: 'RECIT',
            dates: [makeSlot(['Friday'], 780, 840)],
            parentClassId: 'STAT-L2',
          })
        ),
      ],
    });

    // Block Tuesday 1-4 PM so CMSC 128 MUST pick AB-LEC + AB-1L, which forces STAT 1 to pick STAT-L1 + A-1L + A-1R!
    const blocked: BlockedTimeCell[] = [
      { id: 'Tuesday:780-840', day: 'Tuesday', startMinutes: 780, endMinutes: 840 },
    ];

    const plan = makePlan({
      intendedCourses: [cmsc128, stat1],
      blockedCells: blocked,
    });
    const res = await solveAcademicPlan(plan);

    assert.equal(res.status, 'OPTIMAL');
    assert.equal(res.alternatives.length, 1);
    assert.deepEqual(res.alternatives[0].selectedSectionIds.sort(), [
      'AB-1L',
      'AB-LEC',
      'STAT-A1L',
      'STAT-A1R',
      'STAT-L1',
    ]);
    assert.equal(validateScheduleAlternative(plan, res.alternatives[0]).valid, true);
  });

  it('locks pre-enlisted courses (exempting them from capacity pruning) and respects hide/lock flags', async () => {
    // Pre-enlisted course reports 25/25 (full), MUST still be kept and locked as x = 1!
    const preLec = makeSection({
      id: 'PRE-165-S',
      courseId: '165',
      section: 'S',
      activity: 'LEC',
      dates: [makeSlot(['Tuesday', 'Thursday'], 420, 480)],
      activeClassSize: 25,
      maxClassSize: 25,
    });
    const preLab = makeSection({
      id: 'PRE-165-S4L',
      courseId: '165',
      section: 'S-4L',
      activity: 'LAB',
      dates: [makeSlot(['Friday'], 420, 600)],
      activeClassSize: 25,
      maxClassSize: 25,
      parentClass: preLec,
    });
    const preCourse = makeCourse({
      id: '165',
      code: 'CMSC 165',
      isPreEnlisted: true,
      requiredComponents: ['LEC', 'LAB'],
      sections: [makeOption(preLab, { isPreEnlisted: true })],
    });

    // Intended course with 1 full section, 1 hidden section, 1 user-locked section, and 1 open section
    const ethics = makeCourse({
      id: '301',
      code: 'ETHICS 1',
      sections: [
        makeOption(
          makeSection({
            id: 'ETH-FULL',
            courseId: '301',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday', 'Wednesday'], 480, 540)],
            activeClassSize: 40,
            maxClassSize: 40,
          })
        ),
        makeOption(
          makeSection({
            id: 'ETH-HIDDEN',
            courseId: '301',
            section: 'B',
            activity: 'LEC',
            dates: [makeSlot(['Monday', 'Wednesday'], 540, 600)],
          }),
          { flags: { isHidden: true } }
        ),
        makeOption(
          makeSection({
            id: 'ETH-LOCKED',
            courseId: '301',
            section: 'C',
            activity: 'LEC',
            dates: [makeSlot(['Monday', 'Wednesday'], 600, 660)],
          }),
          { flags: { isLocked: true } }
        ),
        makeOption(
          makeSection({
            id: 'ETH-OPEN',
            courseId: '301',
            section: 'D',
            activity: 'LEC',
            dates: [makeSlot(['Monday', 'Wednesday'], 660, 720)],
          })
        ),
      ],
    });

    const plan = makePlan({
      preEnlistedCourses: [preCourse],
      intendedCourses: [ethics],
    });
    const res = await solveAcademicPlan(plan);

    assert.equal(res.status, 'OPTIMAL');
    assert.equal(res.alternatives.length, 1);
    assert.deepEqual(res.alternatives[0].selectedSectionIds.sort(), [
      'ETH-LOCKED',
      'PRE-165-S',
      'PRE-165-S4L',
    ]);
    assert.equal(res.alternatives[0].totalUnits, 6);
    assert.equal(validateScheduleAlternative(plan, res.alternatives[0]).valid, true);
  });

  it('enforces optional academic plan minUnits and maxUnits limits', async () => {
    const c1 = makeCourse({
      id: '401',
      code: 'CMSC 130',
      units: 3,
      sections: [
        makeOption(
          makeSection({
            id: '401-A',
            courseId: '401',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 480, 540)],
          })
        ),
      ],
    });
    const c2 = makeCourse({
      id: '402',
      code: 'CMSC 131',
      units: 3,
      sections: [
        makeOption(
          makeSection({
            id: '402-A',
            courseId: '402',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Tuesday'], 480, 540)],
          })
        ),
      ],
    });

    const planWithin = makePlan({
      intendedCourses: [c1, c2],
      unitLimits: { minUnits: 3, maxUnits: 6 },
    });
    const resOk = await solveAcademicPlan(planWithin);
    assert.equal(resOk.status, 'OPTIMAL');
    assert.equal(resOk.alternatives[0].totalUnits, 6);

    const planOver = makePlan({
      intendedCourses: [c1, c2],
      unitLimits: { maxUnits: 5 },
    });
    const resOver = await solveAcademicPlan(planOver);
    assert.equal(resOver.status, 'INFEASIBLE');
    assert.equal(resOver.alternatives.length, 0);

    const planUnder = makePlan({
      intendedCourses: [c1, c2],
      unitLimits: { minUnits: 9 },
    });
    const resUnder = await solveAcademicPlan(planUnder);
    assert.equal(resUnder.status, 'INFEASIBLE');
    assert.equal(resUnder.alternatives.length, 0);
  });
});

describe('CP-SAT Soft Preferences & Objective Ranking (Eq. 8–15)', () => {
  it('operates in Pure Satisfiability Mode (Z = 0) when all weights are Off', async () => {
    const c1 = makeCourse({
      id: '501',
      code: 'HIST 1',
      sections: [
        makeOption(
          makeSection({
            id: '501-A',
            courseId: '501',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Friday'], 420, 510)],
          })
        ),
        makeOption(
          makeSection({
            id: '501-B',
            courseId: '501',
            section: 'B',
            activity: 'LEC',
            dates: [makeSlot(['Tuesday'], 600, 690)],
          })
        ),
      ],
    });

    const plan = makePlan({
      intendedCourses: [c1],
      preferences: allOffPreferences(),
    });
    const res = await solveAcademicPlan(plan);
    assert.equal(res.status, 'OPTIMAL');
    assert.equal(res.alternatives[0].objectiveScoreZ, 0);
    assert.equal(res.alternatives[0].profileTag, 'Pure SAT');
  });

  it('optimizes Early Start, Late End, Friday, Active Days, and Starred Section preferences', async () => {
    // Course 1: Section EARLY_FRI (Fri 7-8 AM, unstarred) vs Section IDEAL (Tue 10-11 AM, starred)
    // Course 2: Section LATE_WED (Wed 6-7 PM) vs Section TUE_BATCH (Tue 11-12 PM)
    const c1 = makeCourse({
      id: '601',
      code: 'CMSC 123',
      sections: [
        makeOption(
          makeSection({
            id: '601-EARLY-FRI',
            courseId: '601',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Friday'], 420, 480)], // 7-8 AM Friday
          })
        ),
        makeOption(
          makeSection({
            id: '601-IDEAL',
            courseId: '601',
            section: 'B',
            activity: 'LEC',
            dates: [makeSlot(['Tuesday'], 600, 660)], // 10-11 AM Tuesday
          }),
          { flags: { isStarred: true } }
        ),
      ],
    });
    const c2 = makeCourse({
      id: '602',
      code: 'CMSC 124',
      sections: [
        makeOption(
          makeSection({
            id: '602-LATE-WED',
            courseId: '602',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Wednesday'], 1080, 1140)], // 6-7 PM Wednesday
          })
        ),
        makeOption(
          makeSection({
            id: '602-TUE',
            courseId: '602',
            section: 'B',
            activity: 'LEC',
            dates: [makeSlot(['Tuesday'], 660, 720)], // 11-12 PM Tuesday
          })
        ),
      ],
    });

    const prefs = allOffPreferences();
    prefs.acceptableDayBounds = {
      priority: 'High',
      earliestStartMinutes: 540, // 9:00 AM
      latestEndMinutes: 1020, // 5:00 PM
    };
    prefs.minimizeFridayClasses.priority = 'Medium';
    prefs.batchSubjectsToFewerDays.priority = 'Medium';
    prefs.starredSectionPreference.priority = 'High';

    const plan = makePlan({
      intendedCourses: [c1, c2],
      preferences: prefs,
      diversity: {
        maxAlternatives: 3,
        minDifferingSections: 1,
        minHammingDistance: 2,
        alternatePreferenceProfiles: false,
      },
    });

    const res = await solveAcademicPlan(plan);
    assert.equal(res.status, 'OPTIMAL');
    assert.equal(res.alternatives.length, 3);

    // Plan A MUST select the starred, batched Tuesday schedule (601-IDEAL + 602-TUE)
    assert.deepEqual(res.alternatives[0].selectedSectionIds.sort(), ['601-IDEAL', '602-TUE']);

    // Verify monotonic ranking across Plan A <= Plan B <= Plan C when profile alternation is off
    assert.ok(res.alternatives[0].objectiveScoreZ <= res.alternatives[1].objectiveScoreZ);
    assert.ok(res.alternatives[1].objectiveScoreZ <= res.alternatives[2].objectiveScoreZ);
    assert.ok(res.alternatives[0].objectiveScoreZ < res.alternatives[2].objectiveScoreZ);

    // Verify Plan A achieves the exact minimum Z across all 4 feasible combinations
    const preprocessed = preprocessAcademicPlan(plan);
    const combos = [
      ['601-EARLY-FRI', '602-LATE-WED'],
      ['601-EARLY-FRI', '602-TUE'],
      ['601-IDEAL', '602-LATE-WED'],
      ['601-IDEAL', '602-TUE'],
    ];
    let bruteMin = Number.POSITIVE_INFINITY;
    for (const combo of combos) {
      const idxSet = new Set(
        combo.map((sid) => preprocessed.nodes.find((n) => n.sectionId === sid)!.nodeIndex)
      );
      const z = evaluateSelectionObjective(preprocessed, idxSet, prefs).objectiveScoreZ;
      if (z < bruteMin) bruteMin = z;
    }
    assert.equal(res.alternatives[0].objectiveScoreZ, bruteMin);
  });

  it('penalizes continuous blocks exceeding Fatigue Limit (Eq. 12) and prefers schedules with a break', async () => {
    // Fixed Mon 8-10 AM (2h) + Mon 10-12 PM (2h) = 4h continuous if C3 is 12-2 PM (6h continuous)
    // vs C3 at 1-3 PM (1h break -> blocks of 4h and 2h). With maxConsecutiveHours = 4, 1-3 PM has 0 fatigue!
    const c1 = makeCourse({
      id: '701',
      code: 'C1',
      sections: [
        makeOption(
          makeSection({
            id: '701-A',
            courseId: '701',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 480, 600)], // 8-10
          })
        ),
      ],
    });
    const c2 = makeCourse({
      id: '702',
      code: 'C2',
      sections: [
        makeOption(
          makeSection({
            id: '702-A',
            courseId: '702',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 600, 720)], // 10-12
          })
        ),
      ],
    });
    const c3 = makeCourse({
      id: '703',
      code: 'C3',
      sections: [
        makeOption(
          makeSection({
            id: '703-CONT',
            courseId: '703',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 720, 840)], // 12-2 (creates 6h block -> 120m excess)
          })
        ),
        makeOption(
          makeSection({
            id: '703-BREAK',
            courseId: '703',
            section: 'B',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 780, 900)], // 1-3 (1h break -> 0m excess)
          })
        ),
      ],
    });

    const prefs = allOffPreferences();
    prefs.fatigueLimit = { priority: 'High', maxConsecutiveHours: 4 };

    const plan = makePlan({ intendedCourses: [c1, c2, c3], preferences: prefs });
    const res = await solveAcademicPlan(plan);

    assert.equal(res.status, 'OPTIMAL');
    assert.equal(res.alternatives.length, 2);
    assert.ok(res.alternatives[0].selectedSectionIds.includes('703-BREAK'));
    assert.equal(res.alternatives[0].objectiveScoreZ, 0);
    assert.ok(res.alternatives[1].selectedSectionIds.includes('703-CONT'));
    assert.ok(res.alternatives[1].objectiveScoreZ > 0);
  });

  it('penalizes Excessive Gaps > 120 minutes (Eq. 14) and recognizes intermediate classes bridging gaps', async () => {
    // Fixed Monday 8-9 AM and Monday 2-3 PM (5-hour gap = 300 min -> 180 min excess if empty).
    // Course 3 has:
    //   - Section BRIDGE: Monday 11 AM - 12 PM (splits 300 min gap into two 120 min gaps -> 0 excess!)
    //   - Section OTHER_DAY: Tuesday 10 - 11 AM (leaves 300 min Monday gap intact -> 180 min excess!)
    const c1 = makeCourse({
      id: '801',
      code: 'G1',
      sections: [
        makeOption(
          makeSection({
            id: '801-A',
            courseId: '801',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 480, 540)], // 8-9 AM
          })
        ),
      ],
    });
    const c2 = makeCourse({
      id: '802',
      code: 'G2',
      sections: [
        makeOption(
          makeSection({
            id: '802-A',
            courseId: '802',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 840, 900)], // 2-3 PM
          })
        ),
      ],
    });
    const c3 = makeCourse({
      id: '803',
      code: 'G3',
      sections: [
        makeOption(
          makeSection({
            id: '803-BRIDGE',
            courseId: '803',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 660, 720)], // 11 AM - 12 PM
          })
        ),
        makeOption(
          makeSection({
            id: '803-TUE',
            courseId: '803',
            section: 'B',
            activity: 'LEC',
            dates: [makeSlot(['Tuesday'], 600, 660)],
          })
        ),
      ],
    });

    const prefs = allOffPreferences();
    prefs.minimizeExcessiveGaps = { priority: 'High', gapThresholdMinutes: 120 };

    const plan = makePlan({ intendedCourses: [c1, c2, c3], preferences: prefs });
    const res = await solveAcademicPlan(plan);

    assert.equal(res.status, 'OPTIMAL');
    assert.equal(res.alternatives.length, 2);
    assert.ok(res.alternatives[0].selectedSectionIds.includes('803-BRIDGE'));
    assert.equal(res.alternatives[0].objectiveScoreZ, 0);
    assert.ok(res.alternatives[1].selectedSectionIds.includes('803-TUE'));
    assert.ok(res.alternatives[1].objectiveScoreZ > 0);
  });

  it('respects relative priority weights (High=10 beats Low=2)', async () => {
    // Section A: Friday 10-11 AM (violates Friday penalty, 0 early penalty)
    // Section B: Monday 7-8 AM (violates Early Start penalty for 9 AM threshold, 0 Friday penalty)
    const course = makeCourse({
      id: '901',
      code: 'W1',
      sections: [
        makeOption(
          makeSection({
            id: '901-FRI',
            courseId: '901',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Friday'], 600, 660)],
          })
        ),
        makeOption(
          makeSection({
            id: '901-EARLY',
            courseId: '901',
            section: 'B',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 420, 480)],
          })
        ),
      ],
    });

    // Case 1: Friday avoidance High (10), Day bounds Low (2) -> picks 901-EARLY
    const prefsAvoidFri = allOffPreferences();
    prefsAvoidFri.minimizeFridayClasses.priority = 'High';
    prefsAvoidFri.acceptableDayBounds = {
      priority: 'Low',
      earliestStartMinutes: 540,
      latestEndMinutes: 1080,
    };
    const res1 = await solveAcademicPlan(
      makePlan({ intendedCourses: [course], preferences: prefsAvoidFri })
    );
    assert.equal(res1.alternatives[0].selectedSectionIds[0], '901-EARLY');

    // Case 2: Day bounds High (10), Friday avoidance Low (2) -> picks 901-FRI
    const prefsAvoidEarly = allOffPreferences();
    prefsAvoidEarly.minimizeFridayClasses.priority = 'Low';
    prefsAvoidEarly.acceptableDayBounds = {
      priority: 'High',
      earliestStartMinutes: 540,
      latestEndMinutes: 1080,
    };
    const res2 = await solveAcademicPlan(
      makePlan({ intendedCourses: [course], preferences: prefsAvoidEarly })
    );
    assert.equal(res2.alternatives[0].selectedSectionIds[0], '901-FRI');
  });
});

describe('Iterative Exclusion & Structural Diversity (Eq. 16)', () => {
  it('generates 3 distinct schedules enforcing strict Hamming distance D >= 4 excluding pre-enlisted', async () => {
    const preCourse = makeCourse({
      id: '1000',
      code: 'PE 1',
      units: 2,
      isPreEnlisted: true,
      sections: [
        makeOption(
          makeSection({
            id: 'PE-1',
            courseId: '1000',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Saturday'], 480, 600)],
          }),
          { isPreEnlisted: true }
        ),
      ],
    });

    // 3 courses x 3 non-overlapping options each = 27 schedules; strict m=2 => D >= 4
    const makeThreeOptionCourse = (id: string, code: string, baseMin: number) =>
      makeCourse({
        id,
        code,
        sections: [
          makeOption(
            makeSection({
              id: `${id}-1`,
              courseId: id,
              section: '1',
              activity: 'LEC',
              dates: [makeSlot(['Monday'], baseMin, baseMin + 60)],
            })
          ),
          makeOption(
            makeSection({
              id: `${id}-2`,
              courseId: id,
              section: '2',
              activity: 'LEC',
              dates: [makeSlot(['Tuesday'], baseMin, baseMin + 60)],
            })
          ),
          makeOption(
            makeSection({
              id: `${id}-3`,
              courseId: id,
              section: '3',
              activity: 'LEC',
              dates: [makeSlot(['Wednesday'], baseMin, baseMin + 60)],
            })
          ),
        ],
      });

    const plan = makePlan({
      preEnlistedCourses: [preCourse],
      intendedCourses: [
        makeThreeOptionCourse('1001', 'CS 1', 480),
        makeThreeOptionCourse('1002', 'CS 2', 540),
        makeThreeOptionCourse('1003', 'CS 3', 600),
      ],
      preferences: createDefaultAcademicPlanState().preferences,
      diversity: {
        maxAlternatives: 3,
        minDifferingSections: 2,
        minHammingDistance: 4,
        alternatePreferenceProfiles: true,
      },
    });

    const res = await solveAcademicPlan(plan);
    assert.equal(res.status, 'OPTIMAL');
    assert.equal(res.alternatives.length, 3);
    assert.deepEqual(
      res.alternatives.map((a) => a.planLabel),
      ['Plan A', 'Plan B', 'Plan C']
    );

    // Every pairwise Hamming distance (excluding pre-enlisted PE-1) must be >= 4
    const preprocessed = preprocessAcademicPlan(plan);
    const flexSets = res.alternatives.map(
      (alt) =>
        new Set(
          alt.selectedSectionIds
            .map((sid) => preprocessed.nodes.find((n) => n.sectionId === sid)!)
            .filter((n) => !n.isPreEnlisted)
            .map((n) => n.nodeIndex)
        )
    );

    for (let i = 0; i < flexSets.length; i++) {
      assert.ok(res.alternatives[i].selectedSectionIds.includes('PE-1'));
      for (let j = i + 1; j < flexSets.length; j++) {
        assert.ok(
          computeHammingDistance(flexSets[i], flexSets[j]) >= 4,
          `Expected Hamming distance >= 4 between Plan ${i} and Plan ${j}`
        );
      }
    }

    // 100% Schedule Validity Rate across all 3 generated plans
    const svrReport = computeScheduleValidityRate(plan, res.alternatives);
    assert.equal(svrReport.scheduleValidityRate, 1);
  });

  it('enforces strict sum == 1 and generates Plan A & Plan B for multi-topic CMSC 191 (SEC WX & SEC EF)', async () => {
    const rawCourse: RawAmisCourse = {
      course_id: 191,
      course_code: 'CMSC 191',
      units: '3',
      is_multiple_enrollment: true,
    };
    const rawSections: RawAmisClass[] = [
      {
        id: 19101,
        course_id: 191,
        section: 'WX',
        activity: 'Introduction to natural language processing',
        hide_faculty: true,
        faculties: [],
        facility_id: 'ICS MH',
        class_dates: [
          {
            mon: false,
            tue: true,
            wed: false,
            thu: false,
            fri: false,
            sat: false,
            start_time: '01:00 PM',
            end_time: '04:00 PM',
          },
        ],
        active_class_size: 12,
        max_class_size: 30,
        is_prerog_open: false,
        parent: null,
      },
      {
        id: 19102,
        course_id: 191,
        section: 'EF',
        activity: 'Knowledge management systems',
        hide_faculty: true,
        faculties: [],
        facility_id: 'ICS LH3',
        class_dates: [
          {
            mon: true,
            tue: false,
            wed: false,
            thu: false,
            fri: false,
            sat: false,
            start_time: '01:00 PM',
            end_time: '04:00 PM',
          },
        ],
        active_class_size: 8,
        max_class_size: 30,
        is_prerog_open: false,
        parent: null,
      },
    ];

    const fromRaw = buildCourseEntryFromRaw(rawCourse, rawSections);

    // Case 2: legacy stored CourseEntry whose requiredComponents still hold the raw topic subtitles
    const legacyStored: CourseEntry = {
      ...fromRaw,
      requiredComponents: [
        'Introduction to natural language processing',
        'Knowledge management systems',
      ],
    };

    // Case 3: sections split across two CourseEntry records sharing the same normalized courseCode
    const splitEntries: CourseEntry[] = [
      {
        ...fromRaw,
        instanceId: 'cmsc191-part-1',
        id: '191-A',
        code: 'CMSC 191',
        canEnrollMultiple: true,
        requiredComponents: ['Introduction to natural language processing'],
        sections: [fromRaw.sections[0]],
      },
      {
        ...fromRaw,
        instanceId: 'cmsc191-part-2',
        id: '191-B',
        code: '  cmsc   191 ',
        canEnrollMultiple: true,
        requiredComponents: ['Knowledge management systems'],
        sections: [fromRaw.sections[1]],
      },
    ];

    const scenarios: Array<{ name: string; intendedCourses: CourseEntry[] }> = [
      { name: 'parsed raw AMIS CMSC 191', intendedCourses: [fromRaw] },
      { name: 'legacy persisted topic requiredComponents', intendedCourses: [legacyStored] },
      { name: 'duplicate normalized courseCode entries', intendedCourses: splitEntries },
    ];

    for (const scenario of scenarios) {
      const plan = createDefaultAcademicPlanState();
      plan.intendedCourses = scenario.intendedCourses;

      const res = await solveAcademicPlan(plan);
      assert.equal(res.status, 'OPTIMAL', `Expected OPTIMAL for ${scenario.name}`);
      assert.equal(
        res.alternatives.length,
        2,
        `Expected 2 distinct plans (Plan A & Plan B) for ${scenario.name}, got ${res.alternatives.length}`
      );
      assert.deepEqual(
        res.alternatives.map((a) => a.planLabel),
        ['Plan A', 'Plan B']
      );

      // Mutual exclusion: each plan picks strictly 1 section (never both SEC WX and SEC EF)
      for (const alt of res.alternatives) {
        assert.equal(
          alt.selectedSectionIds.length,
          1,
          `Expected exactly 1 section in ${alt.planLabel} for ${scenario.name}, got ${alt.selectedSectionIds.join(', ')}`
        );
        assert.equal(alt.totalUnits, 3);
      }

      // Plan A and Plan B must pick the two different sections (SEC WX vs SEC EF)
      const pickedSet = new Set(res.alternatives.map((a) => a.selectedSectionIds[0]));
      assert.deepEqual(Array.from(pickedSet).sort(), ['19101', '19102']);
      assert.deepEqual(res.alternatives[1].hammingDistanceFromPrev, [2]);

      // 100% SVR for generated plans, and SVR validator rejects selecting both simultaneously
      const svr = computeScheduleValidityRate(plan, res.alternatives);
      assert.equal(svr.scheduleValidityRate, 1);

      const invalidBoth = validateScheduleAlternative(plan, {
        ...res.alternatives[0],
        selectedSectionIds: ['19101', '19102'],
      });
      assert.equal(invalidBoth.valid, false);
      assert.ok(invalidBoth.violations.some((v) => v.code === 'DUPLICATE_COMPONENT'));
    }
  });

  it('generates 3 distinct plans (Plan A, Plan B, Plan C) when CMSC 191 has 3+ non-conflicting multi-topic sections', async () => {
    const cmsc191 = makeCourse({
      id: '191',
      code: 'CMSC 191',
      requiredComponents: [],
      sections: [
        makeOption(
          makeSection({
            id: '191-WX',
            courseId: '191',
            section: 'WX',
            activity: 'Introduction to natural language processing',
            dates: [makeSlot(['Tuesday'], 780, 960)],
          })
        ),
        makeOption(
          makeSection({
            id: '191-EF',
            courseId: '191',
            section: 'EF',
            activity: 'Knowledge management systems',
            dates: [makeSlot(['Monday'], 780, 960)],
          })
        ),
        makeOption(
          makeSection({
            id: '191-AB',
            courseId: '191',
            section: 'AB',
            activity: 'Computer vision and deep learning',
            dates: [makeSlot(['Wednesday'], 780, 960)],
          })
        ),
        makeOption(
          makeSection({
            id: '191-CD',
            courseId: '191',
            section: 'CD',
            activity: 'Distributed systems engineering',
            dates: [makeSlot(['Thursday'], 780, 960)],
          })
        ),
      ],
    });

    const plan = createDefaultAcademicPlanState();
    plan.intendedCourses = [cmsc191];

    const res = await solveAcademicPlan(plan);
    assert.equal(res.status, 'OPTIMAL');
    assert.equal(res.alternatives.length, 3);
    assert.deepEqual(
      res.alternatives.map((a) => a.planLabel),
      ['Plan A', 'Plan B', 'Plan C']
    );

    const picked = res.alternatives.map((a) => {
      assert.equal(a.selectedSectionIds.length, 1);
      return a.selectedSectionIds[0];
    });
    assert.equal(new Set(picked).size, 3);
    assert.equal(computeScheduleValidityRate(plan, res.alternatives).scheduleValidityRate, 1);
  });

  it('preserves parent-child LAB linkage when parent sections carry differing Special Topics subtitles', async () => {
    const parentWX = makeSection({
      id: '191-WX-LEC',
      courseId: '191',
      section: 'WX',
      activity: 'Introduction to natural language processing',
      dates: [makeSlot(['Tuesday'], 600, 720)],
    });
    const labWX = makeSection({
      id: '191-WX-1L',
      courseId: '191',
      section: 'WX-1L',
      activity: 'LAB',
      dates: [makeSlot(['Tuesday'], 780, 960)],
      parentClass: parentWX,
    });

    const parentEF = makeSection({
      id: '191-EF-LEC',
      courseId: '191',
      section: 'EF',
      activity: 'Knowledge management systems',
      dates: [makeSlot(['Monday'], 600, 720)],
    });
    const labEF = makeSection({
      id: '191-EF-1L',
      courseId: '191',
      section: 'EF-1L',
      activity: 'LAB',
      dates: [makeSlot(['Monday'], 780, 960)],
      parentClass: parentEF,
    });

    const cmsc191 = makeCourse({
      id: '191',
      code: 'CMSC 191',
      sections: [makeOption(labWX), makeOption(labEF)],
    });

    const plan = createDefaultAcademicPlanState();
    plan.intendedCourses = [cmsc191];

    const res = await solveAcademicPlan(plan);
    assert.equal(res.status, 'OPTIMAL');
    assert.equal(res.alternatives.length, 2);

    const sortedPairs = res.alternatives
      .map((a) => [...a.selectedSectionIds].sort().join('+'))
      .sort();
    assert.deepEqual(sortedPairs, [
      '191-EF-1L+191-EF-LEC',
      '191-WX-1L+191-WX-LEC',
    ]);
    assert.equal(computeScheduleValidityRate(plan, res.alternatives).scheduleValidityRate, 1);
  });
});

describe('Infeasible Schedule Detection & Automatic QuickXplain Diagnosis', () => {
  it('returns INFEASIBLE with QuickXplain course-overlap MUS on unavoidable time overlap between intended courses', async () => {
    const c1 = makeCourse({
      id: '2001',
      code: 'CMSC 127',
      sections: [
        makeOption(
          makeSection({
            id: '2001-A',
            courseId: '2001',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday', 'Wednesday'], 600, 690)],
          })
        ),
      ],
    });
    const c2 = makeCourse({
      id: '2002',
      code: 'CMSC 128',
      sections: [
        makeOption(
          makeSection({
            id: '2002-A',
            courseId: '2002',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday', 'Wednesday'], 630, 720)],
          })
        ),
      ],
    });

    const res = await solveAcademicPlan(makePlan({ intendedCourses: [c1, c2] }));
    assert.equal(res.status, 'INFEASIBLE');
    assert.deepEqual(res.alternatives, []);
    assert.ok(res.diagnosis);
    assert.equal(res.diagnosis.origin, 'PREFERENCE_CONFLICT');
    assert.equal(res.diagnosis.isStructuralConflict, true);
    assert.deepEqual(res.diagnosis.affectedCourseCodes.sort(), ['CMSC 127', 'CMSC 128']);
    assert.ok(res.timing.musExtractionMs !== undefined && res.timing.musExtractionMs >= 0);
  });

  it('detects infeasibility and exact MUS for the thesis Paper Files/2.0.png blocked-time conflict scenario', async () => {
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

    const blockedCells: BlockedTimeCell[] = [
      { id: 'Tuesday:780-840', day: 'Tuesday', startMinutes: 780, endMinutes: 840 },
      { id: 'Tuesday:840-900', day: 'Tuesday', startMinutes: 840, endMinutes: 900 },
      { id: 'Tuesday:900-960', day: 'Tuesday', startMinutes: 900, endMinutes: 960 },
      { id: 'Thursday:780-840', day: 'Thursday', startMinutes: 780, endMinutes: 840 },
      { id: 'Thursday:840-900', day: 'Thursday', startMinutes: 840, endMinutes: 900 },
      { id: 'Thursday:900-960', day: 'Thursday', startMinutes: 900, endMinutes: 960 },
    ];

    const res = await solveAcademicPlan(
      makePlan({
        preEnlistedCourses: [cmsc165],
        intendedCourses: [cmsc128],
        blockedCells,
      })
    );

    assert.equal(res.status, 'INFEASIBLE');
    assert.deepEqual(res.alternatives, []);
    assert.ok(res.diagnosis);
    assert.equal(res.diagnosis.origin, 'PREFERENCE_CONFLICT');
    assert.deepEqual(res.diagnosis.affectedCourseCodes, ['CMSC 128']);
    assert.equal(
      res.diagnosis.conflictSummaryBullets[0],
      'Tue/Thu block conflict: Your blocked hours on Tue/Thu clash directly with the only available sections of CMSC 128.'
    );
    assert.equal(
      res.diagnosis.relaxationSuggestions[0],
      'Consider unblocking 1:00 PM - 4:00 PM or searching for alternative elective courses.'
    );
  });

  it('detects infeasibility when user hides all available sections or locks conflicting sections', async () => {
    const allHidden = makeCourse({
      id: '3001',
      code: 'ARTS 1',
      sections: [
        makeOption(
          makeSection({
            id: '3001-A',
            courseId: '3001',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 600, 660)],
          }),
          { flags: { isHidden: true } }
        ),
      ],
    });

    const resHidden = await solveAcademicPlan(makePlan({ intendedCourses: [allHidden] }));
    assert.equal(resHidden.status, 'INFEASIBLE');
    assert.deepEqual(resHidden.alternatives, []);

    const locked1 = makeCourse({
      id: '3002',
      code: 'KAS 1',
      sections: [
        makeOption(
          makeSection({
            id: '3002-A',
            courseId: '3002',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Wednesday'], 600, 660)],
          }),
          { flags: { isLocked: true } }
        ),
      ],
    });
    const locked2 = makeCourse({
      id: '3003',
      code: 'COMM 10',
      sections: [
        makeOption(
          makeSection({
            id: '3003-A',
            courseId: '3003',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Wednesday'], 600, 660)],
          }),
          { flags: { isLocked: true } }
        ),
        makeOption(
          makeSection({
            id: '3003-B',
            courseId: '3003',
            section: 'B',
            activity: 'LEC',
            dates: [makeSlot(['Thursday'], 600, 660)],
          })
        ),
      ],
    });

    const resLocked = await solveAcademicPlan(makePlan({ intendedCourses: [locked1, locked2] }));
    assert.equal(resLocked.status, 'INFEASIBLE');
    assert.deepEqual(resLocked.alternatives, []);
  });

  it('halts early with EXHAUSTED_CAPACITY diagnosis when an intended course has zero open non-TBA sections', async () => {
    const fullCourse = makeCourse({
      id: '4001',
      code: 'CMSC 191',
      sections: [
        makeOption(
          makeSection({
            id: '4001-FULL',
            courseId: '4001',
            section: 'A',
            activity: 'LEC',
            dates: [makeSlot(['Monday'], 600, 660)],
            activeClassSize: 30,
            maxClassSize: 30,
          })
        ),
        makeOption(
          makeSection({
            id: '4001-TBA',
            courseId: '4001',
            section: 'B',
            activity: 'LEC',
            dates: [],
          })
        ),
      ],
    });

    const res = await solveAcademicPlan(makePlan({ intendedCourses: [fullCourse] }));
    assert.equal(res.status, 'INFEASIBLE');
    assert.deepEqual(res.alternatives, []);
    assert.ok(res.diagnosis);
    assert.equal(res.diagnosis.origin, 'EXHAUSTED_CAPACITY');
    assert.deepEqual(res.diagnosis.affectedCourseCodes, ['CMSC 191']);
    assert.equal(res.timing.solverExecutionMs, 0);
  });
});
