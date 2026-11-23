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
  applyRelaxationActionToPlan,
  removeIntendedCourse,
  toggleBlockedCell,
  toggleCourseAccordion,
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
});
