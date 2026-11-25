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
import {
  isCellLockedByPreEnlisted,
  type BlockedCellCoordinate,
} from './scheduleView.ts';

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
 * Applies a batch `'block'` or `'unblock'` action across a set of timetable cells
 * (e.g. a click-and-drag rectangular selection), skipping locked pre-enlisted cells.
 * Returns the exact same `plan` reference when no cells changed so callers can skip storage writes.
 */
export function applyBlockedCellsRange(
  plan: AcademicPlanState,
  cells: readonly BlockedCellCoordinate[],
  action: 'block' | 'unblock'
): AcademicPlanState {
  if (cells.length === 0) {
    return plan;
  }

  const targetCells: BlockedTimeCell[] = [];
  const targetKeys = new Set<string>();

  for (const cell of cells) {
    const endMinutes = cell.startMinutes + 60;
    if (isCellLockedByPreEnlisted(plan, cell.day, cell.startMinutes, endMinutes)) {
      continue;
    }
    const cellId = `${cell.day}:${cell.startMinutes}-${endMinutes}`;
    if (targetKeys.has(cellId)) {
      continue;
    }
    targetKeys.add(cellId);
    targetCells.push({
      id: cellId,
      day: cell.day,
      startMinutes: cell.startMinutes,
      endMinutes,
    });
  }

  if (targetCells.length === 0) {
    return plan;
  }

  if (action === 'block') {
    const existingKeys = new Set(
      plan.blockedCells.map((c) => `${c.day}:${c.startMinutes}-${c.endMinutes}`)
    );
    const additions = targetCells.filter((cell) => !existingKeys.has(cell.id));
    if (additions.length === 0) {
      return plan;
    }
    return {
      ...plan,
      blockedCells: sortBlockedCells([...plan.blockedCells, ...additions]),
    };
  }

  const nextBlockedCells = plan.blockedCells.filter(
    (c) =>
      !targetKeys.has(c.id) &&
      !targetKeys.has(`${c.day}:${c.startMinutes}-${c.endMinutes}`)
  );
  if (nextBlockedCells.length === plan.blockedCells.length) {
    return plan;
  }
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
 * Drops any stale courses explicitly tagged with a different `termId` to preserve term isolation.
 */
export function addOrUpdateIntendedCourse(
  plan: AcademicPlanState,
  incomingCourse: CourseEntry
): AcademicPlanState {
  const incomingTermId =
    typeof incomingCourse.termId === 'number' && Number.isFinite(incomingCourse.termId)
      ? incomingCourse.termId
      : null;

  const sameTermIntended =
    incomingTermId !== null
      ? plan.intendedCourses.filter(
          (c) => typeof c.termId !== 'number' || c.termId === incomingTermId
        )
      : plan.intendedCourses;

  const existingIdx = !incomingCourse.canEnrollMultiple
    ? sameTermIntended.findIndex((c) => c.id === incomingCourse.id)
    : -1;

  if (existingIdx === -1) {
    return {
      ...plan,
      intendedCourses: [
        ...sameTermIntended,
        {
          ...incomingCourse,
          isPreEnlisted: false,
          isExpanded: true,
        },
      ],
    };
  }

  const existing = sameTermIntended[existingIdx];
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

  const nextCourses = [...sameTermIntended];
  nextCourses[existingIdx] = mergedCourse;

  return {
    ...plan,
    intendedCourses: nextCourses,
  };
}

/**
 * Switches the active academic term on the plan, retaining only courses tagged with
 * `nextTermId` and resetting `lastRefreshTime` so a fresh term sync can run immediately.
 */
export function switchPlanTerm(
  plan: AcademicPlanState,
  nextTermId: number
): AcademicPlanState {
  if (plan.termId === nextTermId) {
    return plan;
  }
  return {
    ...plan,
    termId: nextTermId,
    preEnlistedCourses: plan.preEnlistedCourses.filter((c) => c.termId === nextTermId),
    intendedCourses: plan.intendedCourses.filter((c) => c.termId === nextTermId),
    lastRefreshTime: null,
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
