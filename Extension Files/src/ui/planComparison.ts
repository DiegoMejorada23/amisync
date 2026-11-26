import { normalizeCourseCodeKey } from '../amis/parser.ts';
import {
  WEEKDAYS,
  type AcademicPlanState,
  type CourseEntry,
  type Weekday,
} from '../types/domain.ts';
import type { GeneratedScheduleAlternative } from '../types/solver.ts';
import { buildTimetableBlocks, formatDaysCompact, type TimetableBlock } from './scheduleView.ts';

export const MAX_COMPARED_PLANS = 3;

export interface PlanComparisonMetrics {
  totalIdleGapMinutes: number;
  totalIdleGapLabel: string;
  earliestStartMinutes: number | null;
  latestEndMinutes: number | null;
  timeRangeLabel: string;
  starredSatisfiedCount: number;
  starredTargetsCount: number;
  starredLabel: string;
  activeDaysCount: number;
  freeDaysCount: number;
}

export interface PlanCourseSelection {
  key: string;
  courseCode: string;
  sectionCodes: string[];
  sectionBadge: string;
  sectionSummary: string;
  scheduleSummary: string;
  isPreEnlisted: boolean;
  isStarred: boolean;
  colorIndex: number;
}

export interface PlanComparisonCardModel {
  index: number;
  alternative: GeneratedScheduleAlternative;
  planLabel: string;
  headerBadge: string;
  statusLabel: 'Optimal' | 'Feasible';
  profileTag: string;
  totalUnits: number;
  totalUnitsLabel: string;
  blocks: TimetableBlock[];
  metrics: PlanComparisonMetrics;
  courseSelections: PlanCourseSelection[];
}

export interface PlanComparisonState {
  alternatives: GeneratedScheduleAlternative[];
  selectedPlanIndex: number;
  isCompareModalOpen: boolean;
}

export function createInitialPlanComparisonState(): PlanComparisonState {
  return {
    alternatives: [],
    selectedPlanIndex: 0,
    isCompareModalOpen: false,
  };
}

/**
 * Transitions comparison state when schedule generation completes:
 * - Auto-opens the comparison modal when 2 or more feasible plans are generated.
 * - Applies the single plan directly without opening a modal when only 1 plan exists.
 */
export function applyGeneratedAlternatives(
  alternatives: readonly GeneratedScheduleAlternative[]
): PlanComparisonState {
  const nextAlternatives = [...alternatives];
  return {
    alternatives: nextAlternatives,
    selectedPlanIndex: 0,
    isCompareModalOpen: nextAlternatives.length >= 2,
  };
}

/**
 * Selects a plan from the comparison modal (or dropdown), sets it active,
 * closes the comparison modal, and preserves all generated alternatives.
 */
export function selectPlanFromComparison(
  state: PlanComparisonState,
  index: number
): PlanComparisonState {
  if (state.alternatives.length === 0) {
    return {
      ...state,
      selectedPlanIndex: 0,
      isCompareModalOpen: false,
    };
  }

  const clampedIndex = Math.max(0, Math.min(state.alternatives.length - 1, Math.trunc(index)));
  return {
    ...state,
    selectedPlanIndex: clampedIndex,
    isCompareModalOpen: false,
  };
}

/**
 * Reopens the comparison modal when 2 or more feasible plans are available.
 */
export function openComparisonModal(state: PlanComparisonState): PlanComparisonState {
  if (state.alternatives.length < 2) {
    return state;
  }
  return {
    ...state,
    isCompareModalOpen: true,
  };
}

/**
 * Dismisses the comparison modal without discarding generated plans or changing the active plan.
 */
export function closeComparisonModal(state: PlanComparisonState): PlanComparisonState {
  if (!state.isCompareModalOpen) {
    return state;
  }
  return {
    ...state,
    isCompareModalOpen: false,
  };
}

/**
 * Determines Escape key priority: close the Compare modal first before dismissing the optimizer shell.
 */
export function getEscapeKeyAction(
  isCompareModalOpen: boolean
): 'close_compare_modal' | 'dismiss_optimizer' {
  return isCompareModalOpen ? 'close_compare_modal' : 'dismiss_optimizer';
}

/**
 * Formats minutes since midnight into concise 12-hour clock text (e.g., `7:00 AM`, `4:30 PM`).
 */
export function formatClock12hShort(minutes: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(minutes)));
  const h24 = Math.floor(clamped / 60);
  const m = clamped % 60;
  const meridiem = h24 >= 12 && h24 < 24 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${meridiem}`;
}

/**
 * Formats a compact time range sharing the trailing meridiem when start and end match
 * (e.g., `1:00–4:00 PM`, `8:00–9:30 AM`, or `11:30 AM–1:00 PM`).
 */
export function formatCompactTimeRange(startMinutes: number, endMinutes: number): string {
  const startStr = formatClock12hShort(startMinutes);
  const endStr = formatClock12hShort(endMinutes);
  const [startClock, startMeridiem] = startStr.split(' ');
  const [endClock, endMeridiem] = endStr.split(' ');
  if (startMeridiem === endMeridiem) {
    return `${startClock}–${endClock} ${endMeridiem}`;
  }
  return `${startStr}–${endStr}`;
}

/**
 * Formats total idle gap minutes into concise hour notation (e.g., `0 hrs`, `1 hr`, `1.5 hrs`).
 */
export function formatIdleGapHours(totalGapMinutes: number): string {
  const safeMinutes = Math.max(0, Math.round(totalGapMinutes));
  if (safeMinutes === 0) {
    return '0 hrs';
  }
  if (safeMinutes % 60 === 0) {
    const hrs = safeMinutes / 60;
    return `${hrs} ${hrs === 1 ? 'hr' : 'hrs'}`;
  }
  const decimalHours = Number((safeMinutes / 60).toFixed(2));
  return `${decimalHours} hrs`;
}

function formatUnitsLabel(units: number): string {
  const rounded = Number.isInteger(units) ? String(units) : String(Number(units.toFixed(1)));
  return `${rounded} ${units === 1 ? 'Unit' : 'Units'}`;
}

/**
 * Formats the comparison card header badge:
 * - Index 0: `Plan A • Recommended / Optimal` (or `Plan A • Recommended / Feasible`)
 * - Index >= 1: `Plan B`, `Plan C`, etc.
 */
export function formatComparisonHeaderBadge(
  alt: GeneratedScheduleAlternative,
  index: number
): string {
  const statusLabel = alt.status === 'OPTIMAL' ? 'Optimal' : 'Feasible';
  if (index === 0) {
    return `${alt.planLabel} • Recommended / ${statusLabel}`;
  }
  return alt.planLabel;
}

function computeIdleGapMinutes(blocks: readonly TimetableBlock[]): number {
  let totalGapMinutes = 0;

  for (const day of WEEKDAYS) {
    const intervals = blocks
      .filter((b) => b.day === day)
      .map((b) => ({ start: b.startMinutes, end: b.endMinutes }))
      .sort((a, b) => a.start - b.start || a.end - b.end);

    if (intervals.length < 2) {
      continue;
    }

    const merged: Array<{ start: number; end: number }> = [intervals[0]];
    for (let i = 1; i < intervals.length; i += 1) {
      const current = intervals[i];
      const prev = merged[merged.length - 1];
      if (current.start <= prev.end) {
        if (current.end > prev.end) {
          prev.end = current.end;
        }
      } else {
        merged.push({ ...current });
      }
    }

    for (let i = 1; i < merged.length; i += 1) {
      const gap = merged[i].start - merged[i - 1].end;
      if (gap > 0) {
        totalGapMinutes += gap;
      }
    }
  }

  return totalGapMinutes;
}

function computeStarredSatisfaction(
  plan: AcademicPlanState,
  selectedSet: ReadonlySet<string>
): { satisfiedCount: number; targetsCount: number } {
  let satisfiedCount = 0;
  let targetsCount = 0;

  for (const course of plan.intendedCourses) {
    if (course.isPreEnlisted) {
      continue;
    }

    const groups = new Map<
      string,
      { hasStarred: boolean; hasSelectedStarred: boolean }
    >();

    for (const option of course.sections) {
      if (option.isPreEnlisted) {
        continue;
      }
      const groupKey = option.section.activity ?? 'DEFAULT';
      const entry = groups.get(groupKey) ?? {
        hasStarred: false,
        hasSelectedStarred: false,
      };
      if (option.flags.isStarred) {
        entry.hasStarred = true;
        if (selectedSet.has(option.section.id)) {
          entry.hasSelectedStarred = true;
        }
      }
      groups.set(groupKey, entry);
    }

    for (const group of groups.values()) {
      if (group.hasStarred) {
        targetsCount += 1;
        if (group.hasSelectedStarred) {
          satisfiedCount += 1;
        }
      }
    }
  }

  return { satisfiedCount, targetsCount };
}

function formatOptionSectionCode(option: CourseEntry['sections'][number]): string {
  const leafCode = option.section.section.trim();
  const parentCode = option.section.parentClass?.section.trim() ?? '';
  if (!parentCode || parentCode === leafCode) {
    return leafCode;
  }
  const normalizedLeaf = leafCode.toUpperCase();
  const normalizedParent = parentCode.toUpperCase();
  if (
    normalizedLeaf.startsWith(`${normalizedParent}-`) ||
    normalizedLeaf.startsWith(`${normalizedParent} `)
  ) {
    return leafCode;
  }
  return `${parentCode} / ${leafCode}`;
}

function formatSectionBadgeText(codes: readonly string[]): string {
  if (codes.length === 0) {
    return 'SEC —';
  }
  return `SEC ${codes.join(', ')}`;
}

function buildSectionScheduleSummary(
  options: readonly CourseEntry['sections'][number][]
): string {
  const seen = new Set<string>();
  const parts: string[] = [];

  const collectSectionDates = (section: CourseEntry['sections'][number]['section']) => {
    if (section.parentClass) {
      collectSectionDates(section.parentClass);
    }
    for (const slot of section.dates) {
      if (slot.days.length === 0) {
        continue;
      }
      const dayText = formatDaysCompact(slot.days);
      const timeText = formatCompactTimeRange(slot.startMinutes, slot.endMinutes);
      const label = `${dayText} ${timeText}`;
      if (!seen.has(label)) {
        seen.add(label);
        parts.push(label);
      }
    }
  };

  for (const opt of options) {
    collectSectionDates(opt.section);
  }

  return parts.join(', ');
}

function buildCourseSelections(
  plan: AcademicPlanState,
  selectedSet: ReadonlySet<string>
): PlanCourseSelection[] {
  const selections: PlanCourseSelection[] = [];
  const seenCourseKeys = new Set<string>();

  // 1. Pre-enlisted anchor courses (always included & locked)
  for (const course of plan.preEnlistedCourses) {
    const groupKey = normalizeCourseCodeKey(course.code) || course.id;
    const codes = Array.from(
      new Set(
        course.sections
          .map((opt) => formatOptionSectionCode(opt))
          .filter((code) => code.length > 0)
      )
    );
    const sectionSummary = codes.length > 0 ? codes.join(', ') : 'Locked';
    seenCourseKeys.add(`PRE:${course.instanceId}:${groupKey}`);
    selections.push({
      key: `pre-${course.instanceId}`,
      courseCode: course.code,
      sectionCodes: codes,
      sectionBadge: codes.length > 0 ? formatSectionBadgeText(codes) : 'LOCKED',
      sectionSummary,
      scheduleSummary: buildSectionScheduleSummary(course.sections),
      isPreEnlisted: true,
      isStarred: false,
      colorIndex: -1,
    });
  }

  // 2. Intended courses with exact color indices matching TimetableGrid
  const courseColorMap = new Map<string, number>();
  plan.intendedCourses.forEach((course: CourseEntry, idx: number) => {
    const courseGroupKey = normalizeCourseCodeKey(course.code) || course.id;
    if (!courseColorMap.has(courseGroupKey)) {
      courseColorMap.set(courseGroupKey, idx % 6);
    }
    const colorIndex = courseColorMap.get(courseGroupKey) ?? 0;

    const chosenOptions = course.sections.filter(
      (opt) =>
        opt.isPreEnlisted ||
        course.isPreEnlisted ||
        selectedSet.has(opt.section.id)
    );

    const codes = Array.from(
      new Set(
        chosenOptions
          .map((opt) => formatOptionSectionCode(opt))
          .filter((code) => code.length > 0)
      )
    );

    // Fallback if only parent IDs appeared in selectedSectionIds
    if (codes.length === 0) {
      for (const opt of course.sections) {
        if (opt.section.parentClass && selectedSet.has(opt.section.parentClass.id)) {
          codes.push(opt.section.parentClass.section.trim());
        }
      }
    }

    const dedupCodes = Array.from(new Set(codes.filter((c) => c.length > 0)));
    const isStarred = chosenOptions.some((opt) => opt.flags.isStarred);
    const isLocked = course.isPreEnlisted || chosenOptions.every((opt) => opt.isPreEnlisted && chosenOptions.length > 0);
    const uniqueKey = `INT:${course.instanceId}:${courseGroupKey}`;
    if (seenCourseKeys.has(uniqueKey)) {
      return;
    }
    seenCourseKeys.add(uniqueKey);

    selections.push({
      key: `int-${course.instanceId}`,
      courseCode: course.code,
      sectionCodes: dedupCodes,
      sectionBadge: formatSectionBadgeText(dedupCodes),
      sectionSummary: dedupCodes.length > 0 ? dedupCodes.join(', ') : '—',
      scheduleSummary: buildSectionScheduleSummary(chosenOptions),
      isPreEnlisted: isLocked,
      isStarred,
      colorIndex: isLocked ? -1 : colorIndex,
    });
  });

  return selections;
}

/**
 * Computes concise trade-off metrics for a single generated schedule alternative.
 */
export function computePlanComparisonMetrics(
  plan: AcademicPlanState,
  alternative: GeneratedScheduleAlternative,
  precomputedBlocks?: readonly TimetableBlock[]
): PlanComparisonMetrics {
  const blocks = precomputedBlocks ?? buildTimetableBlocks(plan, alternative);
  const selectedSet = new Set(alternative.selectedSectionIds);

  const totalIdleGapMinutes = computeIdleGapMinutes(blocks);
  const totalIdleGapLabel = formatIdleGapHours(totalIdleGapMinutes);

  let earliestStartMinutes: number | null = null;
  let latestEndMinutes: number | null = null;
  const activeDays = new Set<Weekday>();

  for (const block of blocks) {
    activeDays.add(block.day);
    if (earliestStartMinutes === null || block.startMinutes < earliestStartMinutes) {
      earliestStartMinutes = block.startMinutes;
    }
    if (latestEndMinutes === null || block.endMinutes > latestEndMinutes) {
      latestEndMinutes = block.endMinutes;
    }
  }

  const timeRangeLabel =
    earliestStartMinutes !== null && latestEndMinutes !== null
      ? `${formatClock12hShort(earliestStartMinutes)} – ${formatClock12hShort(latestEndMinutes)}`
      : 'No classes';

  const { satisfiedCount, targetsCount } = computeStarredSatisfaction(plan, selectedSet);
  const starredLabel =
    targetsCount > 0
      ? `${satisfiedCount}/${targetsCount} starred`
      : `${satisfiedCount} starred`;

  return {
    totalIdleGapMinutes,
    totalIdleGapLabel,
    earliestStartMinutes,
    latestEndMinutes,
    timeRangeLabel,
    starredSatisfiedCount: satisfiedCount,
    starredTargetsCount: targetsCount,
    starredLabel,
    activeDaysCount: activeDays.size,
    freeDaysCount: WEEKDAYS.length - activeDays.size,
  };
}

/**
 * Builds up to 3 comparison card view models for side-by-side plan comparison.
 */
export function buildPlanComparisonCards(
  plan: AcademicPlanState,
  alternatives: readonly GeneratedScheduleAlternative[]
): PlanComparisonCardModel[] {
  return alternatives.slice(0, MAX_COMPARED_PLANS).map((alt, index) => {
    const blocks = buildTimetableBlocks(plan, alt);
    const selectedSet = new Set(alt.selectedSectionIds);
    const metrics = computePlanComparisonMetrics(plan, alt, blocks);
    const courseSelections = buildCourseSelections(plan, selectedSet);
    const statusLabel = alt.status === 'OPTIMAL' ? 'Optimal' : 'Feasible';

    return {
      index,
      alternative: alt,
      planLabel: alt.planLabel,
      headerBadge: formatComparisonHeaderBadge(alt, index),
      statusLabel,
      profileTag: alt.profileTag,
      totalUnits: alt.totalUnits,
      totalUnitsLabel: formatUnitsLabel(alt.totalUnits),
      blocks,
      metrics,
      courseSelections,
    };
  });
}
