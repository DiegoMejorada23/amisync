import { applyRelaxationToPlan } from '../solver/explainer.ts';
import {
  WEEKDAYS,
  type AcademicPlanState,
  type BlockedTimeCell,
  type CourseEntry,
  type StudentPreferences,
  type Weekday,
} from '../types/domain.ts';
import type { RelaxationAction } from '../types/solver.ts';
import { isCellLockedByPreEnlisted } from './scheduleView.ts';

function sortBlockedCells(cells: readonly BlockedTimeCell[]): BlockedTimeCell[] {
  return [...cells].sort((a, b) => {
    const dayDiff = WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day);
    if (dayDiff !== 0) return dayDiff;
    return a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes;
  });
}

/**
 * Toggles a 1-hour `BLOCKED` cell on the weekly timetable grid.
 * Ignores cells occupied by pre-enlisted locked courses.
 */
export function toggleBlockedCell(
  plan: AcademicPlanState,
  day: Weekday,
  startMinutes: number
): AcademicPlanState {
  const endMinutes = startMinutes + 60;
  if (isCellLockedByPreEnlisted(plan, day, startMinutes, endMinutes)) {
    return plan;
  }

  const cellId = `${day}:${startMinutes}-${endMinutes}`;
  const exists = plan.blockedCells.some(
    (c) =>
      c.id === cellId ||
      (c.day === day && c.startMinutes === startMinutes && c.endMinutes === endMinutes)
  );

  const nextBlockedCells = exists
    ? plan.blockedCells.filter(
        (c) =>
          c.id !== cellId &&
          !(c.day === day && c.startMinutes === startMinutes && c.endMinutes === endMinutes)
      )
    : sortBlockedCells([
        ...plan.blockedCells,
        { id: cellId, day, startMinutes, endMinutes },
      ]);

  return {
    ...plan,
    blockedCells: nextBlockedCells,
  };
}

/**
 * Toggles Hide (`isHidden`), Lock (`isLocked`), or Star (`isStarred`) on an intended course section.
 * Enforces mutual exclusivity between `isHidden` and `isLocked` on the same section.
 */
export function toggleSectionFlag(
  plan: AcademicPlanState,
  courseInstanceId: string,
  sectionId: string,
  flag: 'isHidden' | 'isLocked' | 'isStarred'
): AcademicPlanState {
  return {
    ...plan,
    intendedCourses: plan.intendedCourses.map((course) => {
      if (course.instanceId !== courseInstanceId) {
        return course;
      }
      return {
        ...course,
        sections: course.sections.map((option) => {
          if (option.section.id !== sectionId) {
            return option;
          }
          const nextValue = !option.flags[flag];
          const nextFlags = {
            ...option.flags,
            [flag]: nextValue,
          };
          if (flag === 'isLocked' && nextValue) {
            nextFlags.isHidden = false;
          } else if (flag === 'isHidden' && nextValue) {
            nextFlags.isLocked = false;
          }
          return {
            ...option,
            flags: nextFlags,
          };
        }),
      };
    }),
  };
}

/**
 * Toggles accordion expand/collapse state for an intended course card.
 */
export function toggleCourseAccordion(
  plan: AcademicPlanState,
  courseInstanceId: string
): AcademicPlanState {
  return {
    ...plan,
    intendedCourses: plan.intendedCourses.map((course) =>
      course.instanceId === courseInstanceId
        ? { ...course, isExpanded: !course.isExpanded }
        : course
    ),
  };
}

/**
 * Adds a newly fetched AMIS course or updates an existing non-repeatable course in place,
 * preserving user section flags (`isHidden`, `isLocked`, `isStarred`) keyed by `section.id`.
 */
export function addOrUpdateIntendedCourse(
  plan: AcademicPlanState,
  incomingCourse: CourseEntry
): AcademicPlanState {
  const existingIdx = !incomingCourse.canEnrollMultiple
    ? plan.intendedCourses.findIndex((c) => c.id === incomingCourse.id)
    : -1;

  if (existingIdx === -1) {
    return {
      ...plan,
      intendedCourses: [
        ...plan.intendedCourses,
        {
          ...incomingCourse,
          isPreEnlisted: false,
          isExpanded: true,
        },
      ],
    };
  }

  const existing = plan.intendedCourses[existingIdx];
  const prevFlagsBySectionId = new Map(
    existing.sections.map((opt) => [opt.section.id, opt.flags])
  );

  const mergedCourse: CourseEntry = {
    ...incomingCourse,
    instanceId: existing.instanceId,
    isPreEnlisted: false,
    isExpanded: existing.isExpanded,
    sections: incomingCourse.sections.map((opt) => {
      const prevFlags = prevFlagsBySectionId.get(opt.section.id);
      return prevFlags
        ? {
            ...opt,
            flags: { ...prevFlags },
          }
        : opt;
    }),
  };

  const nextCourses = [...plan.intendedCourses];
  nextCourses[existingIdx] = mergedCourse;

  return {
    ...plan,
    intendedCourses: nextCourses,
  };
}

/**
 * Removes an intended course by `instanceId`.
 */
export function removeIntendedCourse(
  plan: AcademicPlanState,
  courseInstanceId: string
): AcademicPlanState {
  return {
    ...plan,
    intendedCourses: plan.intendedCourses.filter((c) => c.instanceId !== courseInstanceId),
  };
}

/**
 * Updates synced AMIS term metadata and pre-enlisted anchor courses.
 */
export function mergeSyncedPreEnlistedCourses(
  plan: AcademicPlanState,
  preEnlistedCourses: CourseEntry[],
  termId: number,
  refreshedAt: string
): AcademicPlanState {
  return {
    ...plan,
    termId,
    preEnlistedCourses,
    lastRefreshTime: refreshedAt,
  };
}

export interface SyncedCourseRefreshOutcome {
  instanceId: string;
  courseCode: string;
  refreshedCourse?: CourseEntry | null;
  notFoundOnNewTerm?: boolean;
}

/**
 * Reconciles a live AMIS sync into the current AcademicPlanState:
 * - Updates termId, pre-enlisted courses, and lastRefreshTime.
 * - Updates refreshed intended courses in place (preserving section flags and accordion state).
 * - If the active AMIS term changed, evicts stale courses that do not exist in the new term.
 */
export function reconcileSyncedPlan(
  prevPlan: AcademicPlanState,
  options: {
    termId: number;
    preEnlistedCourses: CourseEntry[];
    refreshedAt: string;
    intendedOutcomes: readonly SyncedCourseRefreshOutcome[];
  }
): { plan: AcademicPlanState; removedCourseCodes: string[] } {
  const termChanged = prevPlan.termId !== null && prevPlan.termId !== options.termId;
  let updatedPlan = mergeSyncedPreEnlistedCourses(
    prevPlan,
    options.preEnlistedCourses,
    options.termId,
    options.refreshedAt
  );

  const evictedInstanceIds = new Set<string>();
  const removedCourseCodes: string[] = [];

  for (const outcome of options.intendedOutcomes) {
    if (outcome.refreshedCourse) {
      updatedPlan = addOrUpdateIntendedCourse(updatedPlan, outcome.refreshedCourse);
    } else if (termChanged && outcome.notFoundOnNewTerm) {
      evictedInstanceIds.add(outcome.instanceId);
      removedCourseCodes.push(outcome.courseCode);
    }
  }

  if (evictedInstanceIds.size > 0) {
    updatedPlan = {
      ...updatedPlan,
      intendedCourses: updatedPlan.intendedCourses.filter(
        (course) => !evictedInstanceIds.has(course.instanceId)
      ),
    };
  }

  return {
    plan: updatedPlan,
    removedCourseCodes,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Applies a StudentPreferences updater while clamping fatigue and day-bound slider ranges.
 */
export function updatePreferences(
  plan: AcademicPlanState,
  updater: (prev: StudentPreferences) => StudentPreferences
): AcademicPlanState {
  const next = updater(plan.preferences);
  const maxConsecutiveHours = clamp(Math.round(next.fatigueLimit.maxConsecutiveHours), 1, 12);
  let earliestStartMinutes = clamp(Math.round(next.acceptableDayBounds.earliestStartMinutes), 420, 1140);
  let latestEndMinutes = clamp(Math.round(next.acceptableDayBounds.latestEndMinutes), 420, 1140);

  if (earliestStartMinutes > latestEndMinutes) {
    latestEndMinutes = earliestStartMinutes;
  }

  return {
    ...plan,
    preferences: {
      ...next,
      fatigueLimit: {
        ...next.fatigueLimit,
        maxConsecutiveHours,
      },
      acceptableDayBounds: {
        ...next.acceptableDayBounds,
        earliestStartMinutes,
        latestEndMinutes,
      },
      minimizeExcessiveGaps: {
        ...next.minimizeExcessiveGaps,
        gapThresholdMinutes: 120,
      },
    },
  };
}

/**
 * Applies a QuickXplain MUS relaxation action immutably to the active AcademicPlanState.
 */
export function applyRelaxationActionToPlan(
  plan: AcademicPlanState,
  action: RelaxationAction
): AcademicPlanState {
  return applyRelaxationToPlan(plan, action);
}
