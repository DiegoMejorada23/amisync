import { getSectionNstpTrack, isNstpCourse } from '../amis/parser.ts';
import { applyRelaxationToPlan } from '../solver/explainer.ts';
import {
  WEEKDAYS,
  type AcademicPlanState,
  type BlockedTimeCell,
  type CourseEntry,
  type NstpTrackFilter,
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
 * Selects an NSTP component track filter (`'All'`, `'CWTS'`, `'LTS'`, `'ROTC'`, or `'Unlabeled'`) for a course:
 * - Selecting a specific track filters the visible list and auto-hides sections from other NSTP tracks
 *   (`isHidden: true`, clearing `isLocked`) so the CP-SAT solver only considers that track.
 * - Selecting `'All'` unhides non-pre-enlisted sections across all tracks.
 */
export function applyNstpTrackFilter(
  plan: AcademicPlanState,
  courseInstanceId: string,
  trackFilter: NstpTrackFilter
): AcademicPlanState {
  const courseIdx = plan.intendedCourses.findIndex((c) => c.instanceId === courseInstanceId);
  if (courseIdx === -1) {
    return plan;
  }

  const course = plan.intendedCourses[courseIdx];
  if (!isNstpCourse(course.code)) {
    return plan;
  }

  if (
    trackFilter !== 'All' &&
    !course.sections.some((opt) => getSectionNstpTrack(opt.section, course.code) === trackFilter)
  ) {
    return plan;
  }

  let sectionsChanged = false;
  const nextSections = course.sections.map((opt) => {
    if (opt.isPreEnlisted) {
      return opt;
    }

    if (trackFilter === 'All') {
      if (!opt.flags.isHidden) {
        return opt;
      }
      sectionsChanged = true;
      return {
        ...opt,
        flags: {
          ...opt.flags,
          isHidden: false,
        },
      };
    }

    const secTrack = getSectionNstpTrack(opt.section, course.code);
    const matchesTrack = secTrack === trackFilter;
    const targetHidden = !matchesTrack;
    const targetLocked = matchesTrack ? opt.flags.isLocked : false;

    if (opt.flags.isHidden === targetHidden && opt.flags.isLocked === targetLocked) {
      return opt;
    }

    sectionsChanged = true;
    return {
      ...opt,
      flags: {
        ...opt.flags,
        isHidden: targetHidden,
        isLocked: targetLocked,
      },
    };
  });

  const prevFilter = course.nstpTrackFilter ?? 'All';
  if (!sectionsChanged && prevFilter === trackFilter) {
    return plan;
  }

  const nextCourses = [...plan.intendedCourses];
  nextCourses[courseIdx] = {
    ...course,
    nstpTrackFilter: trackFilter,
    sections: sectionsChanged ? nextSections : course.sections,
  };

  return {
    ...plan,
    intendedCourses: nextCourses,
  };
}

/**
 * Normalizes an AMIS course code by trimming, collapsing internal whitespace,
 * and uppercasing (e.g., `"  cmsc   191 "` -> `"CMSC 191"`).
 */
export function normalizeCourseCode(code: string): string {
  return code.trim().replace(/\s+/g, ' ').toUpperCase();
}

export interface AddOrUpdateIntendedCourseOptions {
  /**
   * When true (interactive search/add), unhides all sections (`isHidden: false`)
   * while preserving `isLocked`/`isStarred`, and expands the course accordion.
   */
  unhideAndExpandExisting?: boolean;
}

export type SearchAddCourseOutcome =
  | 'added'
  | 'updated_existing'
  | 'already_pre_enlisted';

export interface AddSearchedIntendedCourseResult {
  plan: AcademicPlanState;
  outcome: SearchAddCourseOutcome;
  courseCode: string;
  unhiddenSectionCount: number;
}

function findMatchingCourseIndex(
  courses: readonly CourseEntry[],
  target: CourseEntry
): number {
  const normalizedTargetCode = normalizeCourseCode(target.code);
  return courses.findIndex(
    (c) =>
      (target.instanceId !== '' && c.instanceId === target.instanceId) ||
      (normalizedTargetCode !== '' &&
        normalizeCourseCode(c.code) === normalizedTargetCode) ||
      (!target.canEnrollMultiple && c.id === target.id)
  );
}

function addOrUpdateIntendedCourseInternal(
  plan: AcademicPlanState,
  incomingCourse: CourseEntry,
  options?: AddOrUpdateIntendedCourseOptions
): {
  plan: AcademicPlanState;
  matchedExisting: boolean;
  courseCode: string;
  unhiddenSectionCount: number;
} {
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

  const existingIdx = findMatchingCourseIndex(sameTermIntended, incomingCourse);

  if (existingIdx === -1) {
    return {
      plan: {
        ...plan,
        intendedCourses: [
          ...sameTermIntended,
          {
            ...incomingCourse,
            isPreEnlisted: false,
            isExpanded: true,
          },
        ],
      },
      matchedExisting: false,
      courseCode: incomingCourse.code,
      unhiddenSectionCount: 0,
    };
  }

  const existing = sameTermIntended[existingIdx];
  const prevFlagsBySectionId = new Map(
    existing.sections.map((opt) => [opt.section.id, opt.flags])
  );
  const unhideAndExpand = Boolean(options?.unhideAndExpandExisting);
  let unhiddenSectionCount = 0;

  const preservedTrackFilter =
    !unhideAndExpand && existing.nstpTrackFilter !== undefined
      ? existing.nstpTrackFilter
      : undefined;

  const mergedCourse: CourseEntry = {
    ...incomingCourse,
    code: existing.code.trim() ? existing.code : incomingCourse.code,
    instanceId: existing.instanceId,
    isPreEnlisted: false,
    isExpanded: unhideAndExpand ? true : existing.isExpanded,
    ...(preservedTrackFilter !== undefined ? { nstpTrackFilter: preservedTrackFilter } : {}),
    sections: incomingCourse.sections.map((opt) => {
      const prevFlags = prevFlagsBySectionId.get(opt.section.id);
      if (!prevFlags) {
        if (
          !unhideAndExpand &&
          preservedTrackFilter &&
          preservedTrackFilter !== 'All' &&
          !opt.isPreEnlisted &&
          isNstpCourse(incomingCourse.code) &&
          getSectionNstpTrack(opt.section, incomingCourse.code) !== preservedTrackFilter
        ) {
          return {
            ...opt,
            flags: { ...opt.flags, isHidden: true, isLocked: false },
          };
        }
        return unhideAndExpand && opt.flags.isHidden
          ? { ...opt, flags: { ...opt.flags, isHidden: false } }
          : opt;
      }
      if (unhideAndExpand && prevFlags.isHidden) {
        unhiddenSectionCount += 1;
      }
      return {
        ...opt,
        flags: {
          isHidden: unhideAndExpand ? false : prevFlags.isHidden,
          isLocked: prevFlags.isLocked,
          isStarred: prevFlags.isStarred,
        },
      };
    }),
  };

  const nextCourses = [...sameTermIntended];
  nextCourses[existingIdx] = mergedCourse;

  return {
    plan: {
      ...plan,
      intendedCourses: nextCourses,
    },
    matchedExisting: true,
    courseCode: mergedCourse.code,
    unhiddenSectionCount,
  };
}

/**
 * Adds a newly fetched AMIS course or updates an existing course in place
 * (matched by `instanceId`, normalized course code, or non-repeatable `id`),
 * preserving user section flags (`isHidden`, `isLocked`, `isStarred`) keyed by `section.id`.
 * Drops any stale courses explicitly tagged with a different `termId` to preserve term isolation.
 */
export function addOrUpdateIntendedCourse(
  plan: AcademicPlanState,
  incomingCourse: CourseEntry,
  options?: AddOrUpdateIntendedCourseOptions
): AcademicPlanState {
  return addOrUpdateIntendedCourseInternal(plan, incomingCourse, options).plan;
}

/**
 * Handles interactive Search & Add for a freshly fetched AMIS course:
 * - Deduplicates against `intendedCourses` (and `preEnlistedCourses`) using normalized course codes.
 * - When already in `intendedCourses`, updates sections in place, sets `isHidden: false` on all
 *   sections while preserving `isLocked` and `isStarred`, and expands the course accordion.
 */
export function addSearchedIntendedCourse(
  plan: AcademicPlanState,
  incomingCourse: CourseEntry
): AddSearchedIntendedCourseResult {
  const incomingTermId =
    typeof incomingCourse.termId === 'number' && Number.isFinite(incomingCourse.termId)
      ? incomingCourse.termId
      : null;

  const result = addOrUpdateIntendedCourseInternal(plan, incomingCourse, {
    unhideAndExpandExisting: true,
  });

  if (result.matchedExisting) {
    return {
      plan: result.plan,
      outcome: 'updated_existing',
      courseCode: result.courseCode,
      unhiddenSectionCount: result.unhiddenSectionCount,
    };
  }

  const sameTermPreEnlisted =
    incomingTermId !== null
      ? plan.preEnlistedCourses.filter(
          (c) => typeof c.termId !== 'number' || c.termId === incomingTermId
        )
      : plan.preEnlistedCourses;

  const preEnlistedIdx = findMatchingCourseIndex(sameTermPreEnlisted, incomingCourse);
  if (preEnlistedIdx !== -1) {
    return {
      plan,
      outcome: 'already_pre_enlisted',
      courseCode: sameTermPreEnlisted[preEnlistedIdx].code,
      unhiddenSectionCount: 0,
    };
  }

  return {
    plan: result.plan,
    outcome: 'added',
    courseCode: result.courseCode,
    unhiddenSectionCount: 0,
  };
}

/**
 * Formats a concise status banner message when a searched course was already present.
 */
export function formatSearchAddStatusMessage(
  result: Pick<AddSearchedIntendedCourseResult, 'outcome' | 'courseCode' | 'unhiddenSectionCount'>
): string | null {
  if (result.outcome === 'updated_existing') {
    if (result.unhiddenSectionCount > 0) {
      const sectionWord = result.unhiddenSectionCount === 1 ? 'section' : 'sections';
      return `${result.courseCode} is already in your list — unhid ${result.unhiddenSectionCount} hidden ${sectionWord}.`;
    }
    return `${result.courseCode} is already in your list — refreshed sections.`;
  }
  if (result.outcome === 'already_pre_enlisted') {
    return `${result.courseCode} is already pre-enlisted in your schedule.`;
  }
  return null;
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
