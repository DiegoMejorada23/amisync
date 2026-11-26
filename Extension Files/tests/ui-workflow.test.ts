import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fetchCourseWithClasses, type AmisHttpExecutor } from '../src/amis/client.ts';
import type { RawAmisClass, RawAmisCourse } from '../src/types/amis.ts';
import {
  createDefaultAcademicPlanState,
  type CourseEntry,
} from '../src/types/domain.ts';
import {
  addOrUpdateIntendedCourse,
  addSearchedIntendedCourse,
  applyRelaxationActionToPlan,
  formatSearchAddStatusMessage,
  normalizeCourseCode,
  removeIntendedCourse,
  switchPlanTerm,
  toggleBlockedCell,
  toggleCourseAccordion,
  toggleIncludeFullSections,
  toggleSectionFlag,
  updatePreferences,
} from '../src/ui/planActions.ts';
import {
  buildTimetableBlocks,
  computePlanUnits,
  formatPlanOptionLabel,
  formatSectionScheduleLines,
  isCellLockedByPreEnlisted,
  parseConflictBullet,
} from '../src/ui/scheduleView.ts';
import { handleWorkerRequest } from '../src/workers/solver.worker.ts';

function makeRawPreEnlistedCourse(): CourseEntry {
  return {
    instanceId: 'pre-cmsc-165',
    id: '165',
    code: 'CMSC 165',
    units: 3,
    canEnrollMultiple: false,
    isPreEnlisted: true,
    requiredComponents: ['LEC', 'LAB'],
    isExpanded: true,
    sections: [
      {
        isPreEnlisted: true,
        flags: { isHidden: false, isLocked: false, isStarred: false },
        section: {
          id: '165-lab',
          courseId: '165',
          section: 'S-4L',
          activity: 'LAB',
          faculties: [],
          location: 'ICS PC7',
          dates: [
            {
              days: ['Friday'],
              startTime: '07:00 AM',
              endTime: '10:00 AM',
              startMinutes: 420,
              endMinutes: 600,
            },
          ],
          activeClassSize: 20,
          maxClassSize: 20,
          isPrerogOpen: false,
          parentClassId: '165-lec',
          parentClass: {
            id: '165-lec',
            courseId: '165',
            section: 'S',
            activity: 'LEC',
            faculties: [],
            location: 'SMA LH',
            dates: [
              {
                days: ['Tuesday', 'Thursday'],
                startTime: '07:00 AM',
                endTime: '08:00 AM',
                startMinutes: 420,
                endMinutes: 480,
              },
            ],
            activeClassSize: 60,
            maxClassSize: 60,
            isPrerogOpen: false,
            parentClassId: null,
            parentClass: null,
          },
        },
      },
    ],
  };
}

function makeRawCmsc128Payload(): {
  course: RawAmisCourse;
  classes: RawAmisClass[];
} {
  const lecParent: RawAmisClass = {
    id: 12800,
    course_id: 128,
    section: 'AB',
    activity: 'LEC',
    hide_faculty: true,
    faculties: [],
    facility_id: 'ICS LH3',
    class_dates: [
      {
        mon: false,
        tue: true,
        wed: false,
        thu: true,
        fri: false,
        sat: false,
        start_time: '08:00 AM',
        end_time: '09:00 AM',
      },
    ],
    active_class_size: 14,
    max_class_size: 25,
    is_prerog_open: false,
    parent: null,
  };

  return {
    course: {
      course_id: 128,
      course_code: 'CMSC 128',
      units: '3',
      is_multiple_enrollment: false,
    },
    classes: [
      {
        id: 12801,
        course_id: 128,
        section: 'AB-1L',
        activity: 'LAB',
        hide_faculty: true,
        faculties: [],
        facility_id: 'ICS PC1',
        class_dates: [
          {
            mon: false,
            tue: false,
            wed: false,
            thu: true,
            fri: false,
            sat: false,
            start_time: '01:00 PM',
            end_time: '04:00 PM',
          },
        ],
        active_class_size: 14,
        max_class_size: 25,
        is_prerog_open: false,
        parent: lecParent,
      },
      {
        id: 12802,
        course_id: 128,
        section: 'CD-2L',
        activity: 'LAB',
        hide_faculty: true,
        faculties: [],
        facility_id: 'ICS PC2',
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
        active_class_size: 3,
        max_class_size: 25,
        is_prerog_open: false,
        parent: lecParent,
      },
    ],
  };
}

describe('Milestone 5 UI View Models, Reducers & End-to-End HITL Workflow', () => {
  it('projects pre-enlisted parent+child blocks and generated schedule blocks onto the timetable', () => {
    const plan = createDefaultAcademicPlanState();
    plan.preEnlistedCourses = [makeRawPreEnlistedCourse()];

    const cmsc128 = makeRawCmsc128Payload();
    const intended: CourseEntry = {
      instanceId: 'inst-128',
      id: '128',
      code: 'CMSC 128',
      units: 3,
      canEnrollMultiple: false,
      isPreEnlisted: false,
      requiredComponents: ['LEC', 'LAB'],
      isExpanded: true,
      sections: [
        {
          isPreEnlisted: false,
          flags: { isHidden: false, isLocked: false, isStarred: false },
          section: {
            id: String(cmsc128.classes[0].id),
            courseId: '128',
            section: 'AB-1L',
            activity: 'LAB',
            faculties: [],
            location: 'ICS PC1',
            dates: [
              {
                days: ['Thursday'],
                startTime: '01:00 PM',
                endTime: '04:00 PM',
                startMinutes: 780,
                endMinutes: 960,
              },
            ],
            activeClassSize: 14,
            maxClassSize: 25,
            isPrerogOpen: false,
            parentClassId: '12800',
            parentClass: {
              id: '12800',
              courseId: '128',
              section: 'AB',
              activity: 'LEC',
              faculties: [],
              location: 'ICS LH3',
              dates: [
                {
                  days: ['Tuesday', 'Thursday'],
                  startTime: '08:00 AM',
                  endTime: '09:00 AM',
                  startMinutes: 480,
                  endMinutes: 540,
                },
              ],
              activeClassSize: 14,
              maxClassSize: 25,
              isPrerogOpen: false,
              parentClassId: null,
              parentClass: null,
            },
          },
        },
      ],
    };
    plan.intendedCourses = [intended];

    assert.equal(isCellLockedByPreEnlisted(plan, 'Tuesday', 420, 480), true);
    assert.equal(isCellLockedByPreEnlisted(plan, 'Tuesday', 780, 840), false);
    assert.equal(computePlanUnits(plan), 6);

    const blocks = buildTimetableBlocks(plan, {
      planLabel: 'Plan A',
      profileTag: 'Balanced',
      totalUnits: 6,
      status: 'OPTIMAL',
      objectiveScoreZ: 0,
      selectedSectionIds: ['165-lec', '165-lab', '12800', '12801'],
      hammingDistanceFromPrev: [],
    });

    // 2 pre-enlisted Tue/Thu + 1 pre-enlisted Fri + 2 CMSC 128 Lec (Tue/Thu) + 1 CMSC 128 Lab (Thu)
    assert.equal(blocks.length, 6);
    const lockedBlocks = blocks.filter((b) => b.isLocked);
    assert.equal(lockedBlocks.length, 3);
    const scheduledBlocks = blocks.filter((b) => !b.isLocked);
    assert.equal(scheduledBlocks.length, 3);
    assert.ok(scheduledBlocks.some((b) => b.title === 'CMSC 128 AB-1L' && b.day === 'Thursday'));
    assert.ok(scheduledBlocks.some((b) => b.title === 'CMSC 128 AB' && b.day === 'Tuesday'));
  });

  it('formats section schedule lines, plan dropdown labels, and conflict course pills', () => {
    const pre = makeRawPreEnlistedCourse();
    const lines = formatSectionScheduleLines(pre.sections[0].section);
    assert.deepEqual(lines, [
      'Lec: TTh 07:00-08:00 • SMA LH',
      'Lab: F 07:00-10:00 • ICS PC7',
    ]);

    assert.equal(
      formatPlanOptionLabel(
        {
          planLabel: 'Plan A',
          profileTag: 'Balanced',
          totalUnits: 18,
          status: 'OPTIMAL',
          objectiveScoreZ: 120,
          selectedSectionIds: [],
          hammingDistanceFromPrev: [],
        },
        0
      ),
      'Plan A (Balanced • 18 Units) - Recommended'
    );

    assert.equal(
      formatPlanOptionLabel(
        {
          planLabel: 'Plan B',
          profileTag: 'Compact Days',
          totalUnits: 18,
          status: 'FEASIBLE',
          objectiveScoreZ: 250,
          selectedSectionIds: [],
          hammingDistanceFromPrev: [2],
        },
        1
      ),
      'Plan B (Compact Days • 18 Units) [Feasible]'
    );

    const parsed = parseConflictBullet(
      'Tue/Thu block conflict: Your blocked hours on Tue/Thu clash directly with the only available sections of CMSC 128.',
      ['CMSC 128']
    );
    assert.equal(parsed.prefix, 'Tue/Thu block conflict:');
    assert.ok(parsed.segments.some((s) => s.type === 'course' && s.value === 'CMSC 128'));
  });

  it('applies pure UI state reducers safely (locked cell guard, flag mutual exclusivity, flag preservation)', () => {
    let plan = createDefaultAcademicPlanState();
    plan.preEnlistedCourses = [makeRawPreEnlistedCourse()];

    // Attempting to block a pre-enlisted slot is ignored.
    const unchanged = toggleBlockedCell(plan, 'Tuesday', 420);
    assert.equal(unchanged.blockedCells.length, 0);

    // Blocking an open slot adds and then removes on second click.
    plan = toggleBlockedCell(plan, 'Tuesday', 780);
    assert.equal(plan.blockedCells.length, 1);
    assert.equal(plan.blockedCells[0].id, 'Tuesday:780-840');
    plan = toggleBlockedCell(plan, 'Tuesday', 780);
    assert.equal(plan.blockedCells.length, 0);

    // Adding a course, toggling Lock/Hide mutual exclusivity + Star, then refreshing preserves flags.
    const preClone: CourseEntry = {
      ...makeRawPreEnlistedCourse(),
      instanceId: 'inst-course-1',
      id: '999',
      code: 'STAT 1',
      isPreEnlisted: false,
      sections: makeRawPreEnlistedCourse().sections.map((opt) => ({
        ...opt,
        isPreEnlisted: false,
      })),
    };
    plan = addOrUpdateIntendedCourse(plan, preClone);
    plan = toggleSectionFlag(plan, 'inst-course-1', '165-lab', 'isLocked');
    plan = toggleSectionFlag(plan, 'inst-course-1', '165-lab', 'isStarred');
    assert.equal(plan.intendedCourses[0].sections[0].flags.isLocked, true);
    assert.equal(plan.intendedCourses[0].sections[0].flags.isStarred, true);

    // Toggling Hide clears Lock automatically.
    plan = toggleSectionFlag(plan, 'inst-course-1', '165-lab', 'isHidden');
    assert.equal(plan.intendedCourses[0].sections[0].flags.isHidden, true);
    assert.equal(plan.intendedCourses[0].sections[0].flags.isLocked, false);

    // Refreshing course data preserves isHidden & isStarred.
    plan = addOrUpdateIntendedCourse(plan, { ...preClone, instanceId: 'new-random-id' });
    assert.equal(plan.intendedCourses[0].instanceId, 'inst-course-1');
    assert.equal(plan.intendedCourses[0].sections[0].flags.isHidden, true);
    assert.equal(plan.intendedCourses[0].sections[0].flags.isStarred, true);

    // Accordion toggle, preference clamping, and removal.
    plan = toggleCourseAccordion(plan, 'inst-course-1');
    assert.equal(plan.intendedCourses[0].isExpanded, false);

    plan = updatePreferences(plan, (prev) => ({
      ...prev,
      fatigueLimit: { priority: 'High', maxConsecutiveHours: 99 },
      acceptableDayBounds: {
        priority: 'High',
        earliestStartMinutes: 900,
        latestEndMinutes: 600,
      },
    }));
    assert.equal(plan.preferences.fatigueLimit.maxConsecutiveHours, 12);
    assert.equal(plan.preferences.acceptableDayBounds.earliestStartMinutes, 900);
    assert.equal(plan.preferences.acceptableDayBounds.latestEndMinutes, 900);

    plan = removeIntendedCourse(plan, 'inst-course-1');
    assert.equal(plan.intendedCourses.length, 0);
  });

  it('executes full end-to-end AMIS fetch -> Worker INFEASIBLE QuickXplain -> 1-click relaxation -> OPTIMAL re-solve', async () => {
    const cmsc128Payload = makeRawCmsc128Payload();
    const mockExecutor: AmisHttpExecutor = async (path) => {
      if (path.startsWith('/api/courses?course_code_like=CMSC+128')) {
        return {
          ok: true,
          status: 200,
          body: { courses: [cmsc128Payload.course] },
        };
      }
      if (path.startsWith('/api/students/classes?')) {
        return {
          ok: true,
          status: 200,
          body: { classes: cmsc128Payload.classes },
        };
      }
      return { ok: false, status: 404, body: null };
    };

    const fetchedCmsc128 = await fetchCourseWithClasses('Bearer mock-jwt', 123, 'CMSC 128', mockExecutor);

    let plan = createDefaultAcademicPlanState();
    plan.termId = 123;
    plan.preEnlistedCourses = [makeRawPreEnlistedCourse()];
    plan = addOrUpdateIntendedCourse(plan, fetchedCmsc128);

    // Block Tue & Thu 1:00 PM - 4:00 PM matching Paper Files/2.0.png
    for (const start of [780, 840, 900]) {
      plan = toggleBlockedCell(plan, 'Tuesday', start);
      plan = toggleBlockedCell(plan, 'Thursday', start);
    }

    const infeasibleRes = await handleWorkerRequest({
      type: 'SOLVE_SCHEDULE',
      requestId: 'e2e-hitl-1',
      plan,
    });
    assert.ok(infeasibleRes && infeasibleRes.type === 'SOLVE_SCHEDULE_RESULT' && infeasibleRes.ok);
    assert.equal(infeasibleRes.payload?.status, 'INFEASIBLE');
    assert.ok(infeasibleRes.payload?.diagnosis);
    assert.deepEqual(infeasibleRes.payload.diagnosis.affectedCourseCodes, ['CMSC 128']);
    assert.ok(
      infeasibleRes.payload.diagnosis.conflictSummaryBullets[0].includes('Tue/Thu block conflict')
    );

    // Pick a verified UNBLOCK_TIME_WINDOW relaxation action and re-solve.
    const unblockAction = infeasibleRes.payload.diagnosis.relaxationActions?.find(
      (a) => a.actionType === 'UNBLOCK_TIME_WINDOW'
    );
    assert.ok(unblockAction, 'Expected at least one UNBLOCK_TIME_WINDOW relaxation action');

    const relaxedPlan = applyRelaxationActionToPlan(plan, unblockAction);
    const resolvedRes = await handleWorkerRequest({
      type: 'SOLVE_SCHEDULE',
      requestId: 'e2e-hitl-2',
      plan: relaxedPlan,
    });

    assert.ok(resolvedRes && resolvedRes.type === 'SOLVE_SCHEDULE_RESULT' && resolvedRes.ok);
    assert.equal(resolvedRes.payload?.status, 'OPTIMAL');
    assert.equal(resolvedRes.payload?.diagnosis, null);
    assert.ok((resolvedRes.payload?.alternatives.length ?? 0) >= 1);
    const selectedIds = resolvedRes.payload?.alternatives[0].selectedSectionIds ?? [];
    assert.ok(selectedIds.includes('165-lec'));
    assert.ok(selectedIds.includes('165-lab'));
    assert.ok(selectedIds.includes('12800'));
    assert.ok(selectedIds.includes('12801') || selectedIds.includes('12802'));
  });

  it('isolates courses and sections by termId across switchPlanTerm and CP-SAT solving', async () => {
    const course1261: CourseEntry = {
      ...makeRawPreEnlistedCourse(),
      instanceId: 'inst-1261',
      id: '165',
      code: 'CMSC 165',
      termId: 1261,
      isPreEnlisted: false,
      sections: makeRawPreEnlistedCourse().sections.map((opt) => ({
        ...opt,
        isPreEnlisted: false,
        section: {
          ...opt.section,
          termId: 1261,
          activeClassSize: 10,
          maxClassSize: 30,
          parentClass: opt.section.parentClass
            ? {
                ...opt.section.parentClass,
                termId: 1261,
                activeClassSize: 20,
                maxClassSize: 60,
              }
            : null,
        },
      })),
    };

    const course1262: CourseEntry = {
      instanceId: 'inst-1262',
      id: '999',
      code: 'STAT 1',
      termId: 1262,
      units: 3,
      canEnrollMultiple: false,
      isPreEnlisted: false,
      requiredComponents: ['LEC'],
      isExpanded: true,
      sections: [
        {
          isPreEnlisted: false,
          flags: { isHidden: false, isLocked: false, isStarred: false },
          section: {
            id: '999-lec',
            courseId: '999',
            termId: 1262,
            section: 'A',
            activity: 'LEC',
            faculties: [],
            location: 'PS C100',
            dates: [
              {
                days: ['Monday', 'Wednesday'],
                startTime: '09:00 AM',
                endTime: '10:30 AM',
                startMinutes: 540,
                endMinutes: 630,
              },
            ],
            activeClassSize: 5,
            maxClassSize: 30,
            isPrerogOpen: false,
            parentClassId: null,
            parentClass: null,
          },
        },
      ],
    };

    // Even if a stale 1262 course sits alongside a 1261 plan, the solver strictly isolates to 1261.
    const mixedPlan = createDefaultAcademicPlanState();
    mixedPlan.termId = 1261;
    mixedPlan.intendedCourses = [course1261, course1262];

    const solved = await handleWorkerRequest({
      type: 'SOLVE_SCHEDULE',
      requestId: 'term-isolation-1',
      plan: mixedPlan,
    });
    assert.ok(solved && solved.type === 'SOLVE_SCHEDULE_RESULT' && solved.ok);
    assert.equal(solved.payload?.status, 'OPTIMAL');
    const selectedIds = solved.payload?.alternatives[0]?.selectedSectionIds ?? [];
    assert.ok(selectedIds.includes('165-lec'));
    assert.ok(selectedIds.includes('165-lab'));
    assert.ok(!selectedIds.includes('999-lec'));

    // Switching the plan term to 1262 evicts 1261 courses and keeps only 1262 courses.
    const switched = switchPlanTerm(mixedPlan, 1262);
    assert.equal(switched.termId, 1262);
    assert.deepEqual(
      switched.intendedCourses.map((c) => c.code),
      ['STAT 1']
    );
  });

  it('deduplicates duplicate course searches case-insensitively, unhides hidden sections while preserving locks/stars, and expands accordion', () => {
    assert.equal(normalizeCourseCode('  cmsc   191 '), 'CMSC 191');

    let plan = createDefaultAcademicPlanState();
    plan.termId = 1261;
    plan.preEnlistedCourses = [
      {
        ...makeRawPreEnlistedCourse(),
        termId: 1261,
      },
    ];

    const cmsc191Initial: CourseEntry = {
      instanceId: 'inst-191-orig',
      id: '191',
      code: 'CMSC 191',
      termId: 1261,
      units: 3,
      canEnrollMultiple: true,
      isPreEnlisted: false,
      requiredComponents: ['LEC'],
      isExpanded: false,
      sections: [
        {
          isPreEnlisted: false,
          flags: { isHidden: true, isLocked: false, isStarred: true },
          section: {
            id: '191-a',
            courseId: '191',
            termId: 1261,
            section: 'A',
            activity: 'LEC',
            faculties: [],
            location: 'ICS LH1',
            dates: [],
            activeClassSize: 10,
            maxClassSize: 30,
            isPrerogOpen: false,
            parentClassId: null,
            parentClass: null,
          },
        },
        {
          isPreEnlisted: false,
          flags: { isHidden: false, isLocked: true, isStarred: false },
          section: {
            id: '191-b',
            courseId: '191',
            termId: 1261,
            section: 'B',
            activity: 'LEC',
            faculties: [],
            location: 'ICS LH2',
            dates: [],
            activeClassSize: 12,
            maxClassSize: 30,
            isPrerogOpen: false,
            parentClassId: null,
            parentClass: null,
          },
        },
      ],
    };

    plan.intendedCourses = [cmsc191Initial];

    // Re-searching CMSC 191 with lowercase/extra spaces and a different course_id / instanceId
    const cmsc191Refetched: CourseEntry = {
      ...cmsc191Initial,
      instanceId: 'inst-191-refetched',
      id: '9191',
      code: '  cmsc   191 ',
      isExpanded: false,
      sections: [
        {
          ...cmsc191Initial.sections[0],
          flags: { isHidden: false, isLocked: false, isStarred: false },
          section: {
            ...cmsc191Initial.sections[0].section,
            activeClassSize: 15,
          },
        },
        {
          ...cmsc191Initial.sections[1],
          flags: { isHidden: false, isLocked: false, isStarred: false },
          section: {
            ...cmsc191Initial.sections[1].section,
            activeClassSize: 18,
          },
        },
        {
          isPreEnlisted: false,
          flags: { isHidden: false, isLocked: false, isStarred: false },
          section: {
            id: '191-c',
            courseId: '9191',
            termId: 1261,
            section: 'C',
            activity: 'LEC',
            faculties: [],
            location: 'ICS LH3',
            dates: [],
            activeClassSize: 5,
            maxClassSize: 30,
            isPrerogOpen: false,
            parentClassId: null,
            parentClass: null,
          },
        },
      ],
    };

    const dupResult = addSearchedIntendedCourse(plan, cmsc191Refetched);
    assert.equal(dupResult.outcome, 'updated_existing');
    assert.equal(dupResult.courseCode, 'CMSC 191');
    assert.equal(dupResult.unhiddenSectionCount, 1);
    assert.equal(
      formatSearchAddStatusMessage(dupResult),
      'CMSC 191 is already in your list — unhid 1 hidden section.'
    );

    // No duplicate course card added; existing card is updated in place and expanded.
    assert.equal(dupResult.plan.intendedCourses.length, 1);
    const updated = dupResult.plan.intendedCourses[0];
    assert.equal(updated.instanceId, 'inst-191-orig');
    assert.equal(updated.code, 'CMSC 191');
    assert.equal(updated.isExpanded, true);
    assert.equal(updated.sections.length, 3);

    // Section A: unhidden, freshly fetched capacity preserved, isStarred preserved.
    assert.equal(updated.sections[0].section.activeClassSize, 15);
    assert.equal(updated.sections[0].flags.isHidden, false);
    assert.equal(updated.sections[0].flags.isStarred, true);
    assert.equal(updated.sections[0].flags.isLocked, false);

    // Section B: freshly fetched capacity preserved, isLocked preserved.
    assert.equal(updated.sections[1].section.activeClassSize, 18);
    assert.equal(updated.sections[1].flags.isHidden, false);
    assert.equal(updated.sections[1].flags.isLocked, true);

    // Section C: newly fetched section added cleanly as visible.
    assert.equal(updated.sections[2].section.id, '191-c');
    assert.equal(updated.sections[2].flags.isHidden, false);

    // Searching again when no sections are hidden refreshes and keeps accordion expanded.
    const collapsedAgain = toggleCourseAccordion(dupResult.plan, 'inst-191-orig');
    assert.equal(collapsedAgain.intendedCourses[0].isExpanded, false);
    const secondDup = addSearchedIntendedCourse(collapsedAgain, cmsc191Refetched);
    assert.equal(secondDup.outcome, 'updated_existing');
    assert.equal(secondDup.unhiddenSectionCount, 0);
    assert.equal(secondDup.plan.intendedCourses.length, 1);
    assert.equal(secondDup.plan.intendedCourses[0].isExpanded, true);
    assert.equal(
      formatSearchAddStatusMessage(secondDup),
      'CMSC 191 is already in your list — refreshed sections.'
    );

    // Searching a course already in preEnlistedCourses does not duplicate into intendedCourses.
    const preSearchResult = addSearchedIntendedCourse(secondDup.plan, {
      ...makeRawPreEnlistedCourse(),
      instanceId: 'searched-165',
      code: 'cmsc 165',
      termId: 1261,
      isPreEnlisted: false,
    });
    assert.equal(preSearchResult.outcome, 'already_pre_enlisted');
    assert.equal(preSearchResult.plan.intendedCourses.length, 1);
    assert.equal(
      formatSearchAddStatusMessage(preSearchResult),
      'CMSC 165 is already pre-enlisted in your schedule.'
    );
  });

  it('toggles includeFullSections via planActions with default false and preserves it through updatePreferences', () => {
    let plan = createDefaultAcademicPlanState();
    assert.equal(plan.preferences.includeFullSections, false);

    plan = toggleIncludeFullSections(plan);
    assert.equal(plan.preferences.includeFullSections, true);

    // updatePreferences preserves includeFullSections
    plan = updatePreferences(plan, (prev) => ({
      ...prev,
      minimizeFridayClasses: { priority: 'High' },
    }));
    assert.equal(plan.preferences.includeFullSections, true);
    assert.equal(plan.preferences.minimizeFridayClasses.priority, 'High');

    // Explicit set to same value is a no-op reference return
    assert.equal(toggleIncludeFullSections(plan, true), plan);

    plan = toggleIncludeFullSections(plan, false);
    assert.equal(plan.preferences.includeFullSections, false);
  });
});
