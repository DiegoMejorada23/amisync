import { normalizeCourseCodeKey } from '../amis/parser.ts';
import {
  WEEKDAYS,
  type AcademicPlanState,
  type CourseEntry,
  type FacultyName,
  type NormalizedSection,
  type Weekday,
} from '../types/domain.ts';
import type { GeneratedScheduleAlternative } from '../types/solver.ts';

export const GRID_DAYS: readonly Weekday[] = WEEKDAYS;

export const GRID_DAY_HEADERS: Record<Weekday, string> = {
  Monday: 'MONDAY',
  Tuesday: 'TUESDAY',
  Wednesday: 'WEDNESDAY',
  Thursday: 'THURSDAY',
  Friday: 'FRIDAY',
  Saturday: 'SATURDAY',
};

export const GRID_DAY_HEADERS_SHORT: Record<Weekday, string> = {
  Monday: 'MON',
  Tuesday: 'TUE',
  Wednesday: 'WED',
  Thursday: 'THU',
  Friday: 'FRI',
  Saturday: 'SAT',
};

export interface GridHourRow {
  startMinutes: number;
  endMinutes: number;
  label: string;
}

export const GRID_MIN_MINUTES = 420; // 7:00 AM
export const GRID_MAX_MINUTES = 1140; // 7:00 PM
export const GRID_TOTAL_MINUTES = GRID_MAX_MINUTES - GRID_MIN_MINUTES; // 720

export const GRID_HOURS: readonly GridHourRow[] = [
  { startMinutes: 420, endMinutes: 480, label: '7-8' },
  { startMinutes: 480, endMinutes: 540, label: '8-9' },
  { startMinutes: 540, endMinutes: 600, label: '9-10' },
  { startMinutes: 600, endMinutes: 660, label: '10-11' },
  { startMinutes: 660, endMinutes: 720, label: '11-12' },
  { startMinutes: 720, endMinutes: 780, label: '12-1' },
  { startMinutes: 780, endMinutes: 840, label: '1-2' },
  { startMinutes: 840, endMinutes: 900, label: '2-3' },
  { startMinutes: 900, endMinutes: 960, label: '3-4' },
  { startMinutes: 960, endMinutes: 1020, label: '4-5' },
  { startMinutes: 1020, endMinutes: 1080, label: '5-6' },
  { startMinutes: 1080, endMinutes: 1140, label: '6-7' },
] as const;

export interface TimetableBlock {
  key: string;
  courseCode: string;
  sectionName: string;
  title: string;
  location: string | null;
  activity: string | null;
  day: Weekday;
  startMinutes: number;
  endMinutes: number;
  topPercent: number;
  heightPercent: number;
  isLocked: boolean;
  colorIndex: number;
  timeRangeLabel: string;
  facultySummary: string;
}

const COMPACT_DAY_MAP: Record<Weekday, string> = {
  Monday: 'M',
  Tuesday: 'T',
  Wednesday: 'W',
  Thursday: 'Th',
  Friday: 'F',
  Saturday: 'S',
};

/**
 * Formats an array of weekdays in compact UPLB notation (e.g., TTh, MWF, Th, T).
 */
export function formatDaysCompact(days: readonly Weekday[]): string {
  const unique = new Set(days);
  return WEEKDAYS.filter((d) => unique.has(d))
    .map((d) => COMPACT_DAY_MAP[d])
    .join('');
}

/**
 * Formats minutes since midnight into compact 12-hour `hh:mm` without meridiem (matching `08:00-09:00`).
 */
export function formatTimeCompact12h(minutes: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(minutes)));
  const h24 = Math.floor(clamped / 60);
  const m = clamped % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Formats minutes since midnight into zero-padded 12-hour clock with meridiem
 * matching Paper Files/1.2.png (`07:00 AM`, `06:00 PM`).
 */
export function formatSliderTime12h(minutes: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(minutes)));
  const h24 = Math.floor(clamped / 60);
  const m = clamped % 60;
  const meridiem = h24 >= 12 && h24 < 24 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${meridiem}`;
}

/**
 * Formats faculty list into a concise display string.
 */
export function formatFacultySummary(faculties: readonly FacultyName[]): string {
  if (!faculties || faculties.length === 0) {
    return 'TBA / Concealed';
  }
  return faculties
    .map((f) => [f.firstName, f.lastName].filter((part) => part.trim().length > 0).join(' '))
    .filter((name) => name.length > 0)
    .join(', ');
}

function formatSingleSectionScheduleLine(section: NormalizedSection): string {
  const rawLabel = section.activity
    ? section.activity.charAt(0).toUpperCase() + section.activity.slice(1).toLowerCase()
    : 'Class';

  if (section.dates.length === 0) {
    return `${rawLabel}: TBA / Asynchronous (Excluded from solver)`;
  }

  const dateStr = section.dates
    .map(
      (d) =>
        `${formatDaysCompact(d.days)} ${formatTimeCompact12h(d.startMinutes)}-${formatTimeCompact12h(d.endMinutes)}`
    )
    .join(', ');

  return section.location ? `${rawLabel}: ${dateStr} • ${section.location}` : `${rawLabel}: ${dateStr}`;
}

/**
 * Formats a section (and its parent lecture if present) into monospace display lines
 * matching Paper Files/1.1.png (e.g., `Lec: TTh 08:00-09:00 • ICS LH3`, `Lab: Th 01:00-04:00 • ICS PC1`).
 */
export function formatSectionScheduleLines(section: NormalizedSection): string[] {
  const lines: string[] = [];
  if (section.parentClass) {
    lines.push(...formatSectionScheduleLines(section.parentClass));
  }
  lines.push(formatSingleSectionScheduleLine(section));
  return lines;
}

export type CapacityBadgeTone = 'ok' | 'warn' | 'full';

/**
 * Computes capacity badge color tone matching Paper Files/1.1.png:
 * green (`ok`) when low fill (< 50%), amber (`warn`) when >= 50%, red (`full`) when full.
 */
export function getCapacityBadgeTone(active: number, max: number): CapacityBadgeTone {
  if (max <= 0 || active >= max) {
    return 'full';
  }
  if (active / max >= 0.5) {
    return 'warn';
  }
  return 'ok';
}

function collectSectionChain(section: NormalizedSection, out: NormalizedSection[]): void {
  if (section.parentClass) {
    collectSectionChain(section.parentClass, out);
  }
  out.push(section);
}

/**
 * Returns true if the given hourly timetable cell intersects any pre-enlisted locked section
 * (including nested parent lectures), preventing time-block toggles over locked courses.
 */
export function isCellLockedByPreEnlisted(
  plan: AcademicPlanState,
  day: Weekday,
  startMinutes: number,
  endMinutes: number
): boolean {
  const checkCourses = [...plan.preEnlistedCourses, ...plan.intendedCourses];
  for (const course of checkCourses) {
    for (const option of course.sections) {
      if (!course.isPreEnlisted && !option.isPreEnlisted) {
        continue;
      }
      const chain: NormalizedSection[] = [];
      collectSectionChain(option.section, chain);
      for (const sec of chain) {
        for (const interval of sec.dates) {
          if (!interval.days.includes(day)) {
            continue;
          }
          if (interval.startMinutes < endMinutes && startMinutes < interval.endMinutes) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function pushSectionTimetableBlocks(
  blocks: TimetableBlock[],
  seenKeys: Set<string>,
  courseCode: string,
  section: NormalizedSection,
  isLocked: boolean,
  colorIndex: number
): void {
  const title = `${courseCode} ${section.section}`;
  const facultySummary = formatFacultySummary(section.faculties);

  for (const interval of section.dates) {
    const clampedStart = Math.max(GRID_MIN_MINUTES, interval.startMinutes);
    const clampedEnd = Math.min(GRID_MAX_MINUTES, interval.endMinutes);
    if (clampedEnd <= clampedStart) {
      continue;
    }

    const topPercent = ((clampedStart - GRID_MIN_MINUTES) / GRID_TOTAL_MINUTES) * 100;
    const heightPercent = ((clampedEnd - clampedStart) / GRID_TOTAL_MINUTES) * 100;
    const timeRangeLabel = `${formatTimeCompact12h(interval.startMinutes)}-${formatTimeCompact12h(interval.endMinutes)}`;

    for (const day of interval.days) {
      const key = `${isLocked ? 'L' : 'S'}:${section.id}:${day}:${interval.startMinutes}-${interval.endMinutes}`;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);

      blocks.push({
        key,
        courseCode,
        sectionName: section.section,
        title,
        location: section.location,
        activity: section.activity,
        day,
        startMinutes: clampedStart,
        endMinutes: clampedEnd,
        topPercent,
        heightPercent,
        isLocked,
        colorIndex,
        timeRangeLabel,
        facultySummary,
      });
    }
  }
}

/**
 * Assigns deterministic palette indices (0..5) to intended courses, deduplicated by
 * normalized course code so Course cards, Timetable blocks, and Comparison swatches match.
 */
export function buildIntendedCourseColorMap(
  intendedCourses: readonly CourseEntry[]
): Map<string, number> {
  const courseColorMap = new Map<string, number>();
  intendedCourses.forEach((course: CourseEntry, idx: number) => {
    const courseGroupKey = normalizeCourseCodeKey(course.code) || course.id;
    if (!courseColorMap.has(courseGroupKey)) {
      courseColorMap.set(courseGroupKey, idx % 6);
    }
  });
  return courseColorMap;
}

export function getIntendedCourseColorIndex(
  course: Pick<CourseEntry, 'code' | 'id'>,
  colorMap: ReadonlyMap<string, number>
): number {
  const courseGroupKey = normalizeCourseCodeKey(course.code) || course.id;
  return colorMap.get(courseGroupKey) ?? 0;
}

/**
 * Projects pre-enlisted locked sections (mint green) and active generated schedule sections
 * (distinct non-mint pastel course palette) onto the weekly Mon-Sat 7 AM - 7 PM grid.
 */
export function buildTimetableBlocks(
  plan: AcademicPlanState,
  activeAlternative: GeneratedScheduleAlternative | null
): TimetableBlock[] {
  const blocks: TimetableBlock[] = [];
  const seenKeys = new Set<string>();
  const lockedSectionIds = new Set<string>();

  // 1. Pre-enlisted courses (and any pre-enlisted options in mixed courses) -> always locked.
  for (const course of plan.preEnlistedCourses) {
    for (const option of course.sections) {
      const chain: NormalizedSection[] = [];
      collectSectionChain(option.section, chain);
      for (const sec of chain) {
        lockedSectionIds.add(sec.id);
        pushSectionTimetableBlocks(blocks, seenKeys, course.code, sec, true, -1);
      }
    }
  }

  for (const course of plan.intendedCourses) {
    for (const option of course.sections) {
      if (!course.isPreEnlisted && !option.isPreEnlisted) {
        continue;
      }
      const chain: NormalizedSection[] = [];
      collectSectionChain(option.section, chain);
      for (const sec of chain) {
        lockedSectionIds.add(sec.id);
        pushSectionTimetableBlocks(blocks, seenKeys, course.code, sec, true, -1);
      }
    }
  }

  // 2. Generated schedule alternative blocks for intended courses.
  if (activeAlternative) {
    const selectedSet = new Set(activeAlternative.selectedSectionIds);
    const courseColorMap = buildIntendedCourseColorMap(plan.intendedCourses);

    plan.intendedCourses.forEach((course: CourseEntry) => {
      const colorIndex = getIntendedCourseColorIndex(course, courseColorMap);

      for (const option of course.sections) {
        const chain: NormalizedSection[] = [];
        collectSectionChain(option.section, chain);
        for (const sec of chain) {
          if (!selectedSet.has(sec.id) || lockedSectionIds.has(sec.id)) {
            continue;
          }
          pushSectionTimetableBlocks(blocks, seenKeys, course.code, sec, false, colorIndex);
        }
      }
    });
  }

  return blocks;
}

/**
 * Computes total units across pre-enlisted and intended courses (deduplicating by normalized course code or id).
 */
export function computePlanUnits(plan: AcademicPlanState): number {
  const seenCourseGroups = new Set<string>();
  let total = 0;

  for (const course of [...plan.preEnlistedCourses, ...plan.intendedCourses]) {
    const groupKey = normalizeCourseCodeKey(course.code) || course.id;
    if (seenCourseGroups.has(groupKey)) {
      continue;
    }
    seenCourseGroups.add(groupKey);
    total += course.units;
  }

  return Number(total.toFixed(2));
}

function formatUnitsLabel(units: number): string {
  const rounded = Number.isInteger(units) ? String(units) : String(Number(units.toFixed(1)));
  return `${rounded} ${units === 1 ? 'Unit' : 'Units'}`;
}

/**
 * Formats the Plan dropdown option text matching Paper Files/1.1.png and SPEC.md Section 7.2:
 * e.g., `Plan A (Balanced • 18 Units) - Recommended` or `Plan A (Balanced • 18 Units) [Feasible]`.
 */
export function formatPlanOptionLabel(
  alt: GeneratedScheduleAlternative,
  index: number
): string {
  const base = `${alt.planLabel} (${alt.profileTag} • ${formatUnitsLabel(alt.totalUnits)})`;
  if (alt.status === 'FEASIBLE') {
    return `${base} [Feasible]`;
  }
  if (index === 0) {
    return `${base} - Recommended`;
  }
  return base;
}

export interface ConflictBulletSegment {
  type: 'text' | 'course';
  value: string;
}

export interface ParsedConflictBullet {
  prefix: string | null;
  segments: ConflictBulletSegment[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splits a conflict bullet into an optional bold heading before `:` and body segments
 * highlighting affected course codes as inline pill badges (matching Paper Files/2.0.png).
 */
export function parseConflictBullet(
  text: string,
  affectedCourseCodes: readonly string[]
): ParsedConflictBullet {
  const colonIdx = text.indexOf(':');
  let prefix: string | null = null;
  let body = text;

  if (colonIdx > 0 && colonIdx < 48) {
    prefix = text.slice(0, colonIdx + 1);
    body = text.slice(colonIdx + 1);
  }

  const uniqueCodes = Array.from(
    new Set(affectedCourseCodes.map((c) => c.trim()).filter((c) => c.length > 0))
  ).sort((a, b) => b.length - a.length);

  if (uniqueCodes.length === 0) {
    return {
      prefix,
      segments: [{ type: 'text', value: body }],
    };
  }

  const pattern = new RegExp(`(${uniqueCodes.map(escapeRegex).join('|')})`, 'g');
  const codeSet = new Set(uniqueCodes);
  const parts = body.split(pattern);
  const segments: ConflictBulletSegment[] = [];

  for (const part of parts) {
    if (!part) continue;
    segments.push({
      type: codeSet.has(part) ? 'course' : 'text',
      value: part,
    });
  }

  return { prefix, segments };
}

export interface BlockedCellCoordinate {
  day: Weekday;
  startMinutes: number;
}

/**
 * Returns true if any persisted `blockedCells` interval intersects `[startMinutes, endMinutes)` on `day`.
 */
export function isSlotBlocked(
  plan: AcademicPlanState,
  day: Weekday,
  startMinutes: number,
  endMinutes: number
): boolean {
  return plan.blockedCells.some(
    (cell) =>
      cell.day === day &&
      cell.startMinutes < endMinutes &&
      startMinutes < cell.endMinutes
  );
}

/**
 * Computes all timetable grid cell coordinates inside the inclusive rectangle bounded by
 * `start` and `end` (covering single clicks, single-day vertical drags, and multi-day rectangular drags).
 */
export function getTimetableCellRange(
  start: BlockedCellCoordinate,
  end: BlockedCellCoordinate
): BlockedCellCoordinate[] {
  const startDayIdx = GRID_DAYS.indexOf(start.day);
  const endDayIdx = GRID_DAYS.indexOf(end.day);
  const startHourIdx = GRID_HOURS.findIndex((h) => h.startMinutes === start.startMinutes);
  const endHourIdx = GRID_HOURS.findIndex((h) => h.startMinutes === end.startMinutes);

  if (startDayIdx === -1 || endDayIdx === -1 || startHourIdx === -1 || endHourIdx === -1) {
    return [];
  }

  const minDay = Math.min(startDayIdx, endDayIdx);
  const maxDay = Math.max(startDayIdx, endDayIdx);
  const minHour = Math.min(startHourIdx, endHourIdx);
  const maxHour = Math.max(startHourIdx, endHourIdx);

  const range: BlockedCellCoordinate[] = [];
  for (let d = minDay; d <= maxDay; d += 1) {
    for (let h = minHour; h <= maxHour; h += 1) {
      range.push({
        day: GRID_DAYS[d],
        startMinutes: GRID_HOURS[h].startMinutes,
      });
    }
  }
  return range;
}
