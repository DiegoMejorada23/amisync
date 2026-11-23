import type { RawAmisClass, RawAmisClassDate, RawAmisCourse } from '../types/amis.ts';
import type {
  ComponentType,
  CourseEntry,
  CourseSectionOption,
  FacultyName,
  NormalizedSection,
  TimeslotInterval,
  Weekday,
} from '../types/domain.ts';
import { AmisError } from './errors.ts';

const TIME_12H_REGEX = /^(\d{1,2}):(\d{2})\s*([APap][Mm])$/;

const DAY_FLAG_MAP: ReadonlyArray<readonly [keyof Pick<RawAmisClassDate, 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'>, Weekday]> = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasValidId(value: unknown): value is string | number {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return false;
}

/**
 * Converts a 12-hour `"hh:mm AM/PM"` string into integer minutes since midnight in `[0, 1439]`.
 * Correctly handles `12:xx AM -> 0:xx` and `12:xx PM -> 12:xx`.
 * Returns `null` if the input does not represent a valid 12-hour clock time.
 */
export function parseTimeToMinutes(timeStr: string): number | null {
  if (typeof timeStr !== 'string') {
    return null;
  }

  const match = timeStr.trim().match(TIME_12H_REGEX);
  if (!match) {
    return null;
  }

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3].toUpperCase();

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }
  if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) {
    return null;
  }

  if (meridiem === 'PM' && hours !== 12) {
    hours += 12;
  } else if (meridiem === 'AM' && hours === 12) {
    hours = 0;
  }

  return hours * 60 + minutes;
}

/**
 * Converts raw AMIS `class_dates` into normalized `TimeslotInterval[]`.
 * Entries with zero active meeting days (TBA / asynchronous) or invalid time bounds are omitted.
 */
export function parseClassDates(rawDates: unknown): TimeslotInterval[] {
  if (!Array.isArray(rawDates)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Expected class_dates to be an array.');
  }

  const intervals: TimeslotInterval[] = [];

  for (const entry of rawDates) {
    if (!isRecord(entry)) {
      throw new AmisError('MALFORMED_RESPONSE', 'Malformed entry inside class_dates.');
    }

    const days: Weekday[] = [];
    for (const [flagKey, weekday] of DAY_FLAG_MAP) {
      if (entry[flagKey] === true) {
        days.push(weekday);
      }
    }

    // TBA / asynchronous class date with no fixed days -> omit per SPEC.md Section 3.4.
    if (days.length === 0) {
      continue;
    }

    const startTime = typeof entry.start_time === 'string' ? entry.start_time.trim() : '';
    const endTime = typeof entry.end_time === 'string' ? entry.end_time.trim() : '';
    const startMinutes = parseTimeToMinutes(startTime);
    const endMinutes = parseTimeToMinutes(endTime);

    if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
      continue;
    }

    intervals.push({
      days,
      startTime,
      endTime,
      startMinutes,
      endMinutes,
    });
  }

  return intervals;
}

function parseFaculties(rawClass: Record<string, unknown>): FacultyName[] {
  if (rawClass.hide_faculty === true) {
    return [];
  }
  if (!Array.isArray(rawClass.faculties)) {
    return [];
  }

  const result: FacultyName[] = [];
  for (const wrapper of rawClass.faculties) {
    if (!isRecord(wrapper) || !isRecord(wrapper.faculty) || !isRecord(wrapper.faculty.user)) {
      continue;
    }
    const user = wrapper.faculty.user;
    result.push({
      firstName: typeof user.first_name === 'string' ? user.first_name : '',
      middleName: typeof user.middle_name === 'string' ? user.middle_name : '',
      lastName: typeof user.last_name === 'string' ? user.last_name : '',
    });
  }
  return result;
}

/**
 * Parses a raw AMIS course object into a normalized `CourseEntry` shell.
 */
export function parseRawCourse(
  raw: unknown,
  options?: { isPreEnlisted?: boolean; instanceId?: string; isExpanded?: boolean }
): CourseEntry {
  if (!isRecord(raw)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Raw course payload must be an object.');
  }
  if (!hasValidId(raw.course_id)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Raw course is missing a valid course_id.');
  }
  if (typeof raw.course_code !== 'string' || raw.course_code.trim() === '') {
    throw new AmisError('MALFORMED_RESPONSE', 'Raw course is missing a valid course_code.');
  }

  const units =
    typeof raw.units === 'number'
      ? raw.units
      : typeof raw.units === 'string'
        ? Number.parseFloat(raw.units)
        : Number.NaN;

  if (!Number.isFinite(units) || units < 0) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      `Raw course "${raw.course_code}" has invalid units.`
    );
  }

  return {
    instanceId: options?.instanceId ?? crypto.randomUUID(),
    id: String(raw.course_id),
    code: raw.course_code.trim(),
    units,
    canEnrollMultiple: Boolean(raw.is_multiple_enrollment),
    isPreEnlisted: Boolean(options?.isPreEnlisted),
    requiredComponents: [],
    sections: [],
    isExpanded: options?.isExpanded ?? true,
  };
}

/**
 * Recursively parses a raw AMIS class/section payload (including nested `parent` lecture)
 * into a `NormalizedSection`, guarding against circular parent references.
 */
export function parseRawClass(
  raw: unknown,
  visitedIds: Set<string> = new Set<string>()
): NormalizedSection {
  if (!isRecord(raw)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Raw class payload must be an object.');
  }
  if (!hasValidId(raw.id)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Raw class is missing a valid id.');
  }
  if (!hasValidId(raw.course_id)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Raw class is missing a valid course_id.');
  }
  if (typeof raw.section !== 'string' || raw.section.trim() === '') {
    throw new AmisError('MALFORMED_RESPONSE', 'Raw class is missing a valid section code.');
  }
  if (
    typeof raw.active_class_size !== 'number' ||
    !Number.isFinite(raw.active_class_size) ||
    typeof raw.max_class_size !== 'number' ||
    !Number.isFinite(raw.max_class_size)
  ) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      `Raw class "${raw.section}" has invalid class size bounds.`
    );
  }

  const id = String(raw.id);
  if (visitedIds.has(id)) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      `Circular parent reference detected for class id "${id}".`
    );
  }

  const nextVisited = new Set(visitedIds);
  nextVisited.add(id);

  const activity =
    typeof raw.activity === 'string' && raw.activity.trim() !== '' ? raw.activity.trim() : null;

  const location =
    typeof raw.facility_id === 'string' && raw.facility_id.trim() !== ''
      ? raw.facility_id.trim()
      : null;

  const parentClass =
    raw.parent !== null && raw.parent !== undefined
      ? parseRawClass(raw.parent, nextVisited)
      : null;

  const parentClassId = parentClass
    ? parentClass.id
    : hasValidId(raw.parent_class_id)
      ? String(raw.parent_class_id)
      : null;

  return {
    id,
    courseId: String(raw.course_id),
    section: raw.section.trim(),
    activity,
    faculties: parseFaculties(raw),
    location,
    dates: parseClassDates(raw.class_dates),
    activeClassSize: raw.active_class_size,
    maxClassSize: raw.max_class_size,
    isPrerogOpen: Boolean(raw.is_prerog_open),
    parentClassId,
    parentClass,
  };
}

/**
 * Canonical section comparator matching AMISSU/SPEC.md Section 3.4:
 * sorts by activity, then naturally (numeric-aware) by section name.
 */
export function compareSectionsCanonical(a: NormalizedSection, b: NormalizedSection): number {
  const activityCmp = (a.activity ?? '').localeCompare(b.activity ?? '');
  if (activityCmp !== 0) {
    return activityCmp;
  }
  return a.section.localeCompare(b.section, undefined, { numeric: true });
}

/**
 * Returns true iff the section and all linked parent sections have at least one fixed meeting interval.
 */
export function hasFixedSchedule(section: NormalizedSection): boolean {
  if (section.dates.length === 0) {
    return false;
  }
  return section.parentClass === null || hasFixedSchedule(section.parentClass);
}

/**
 * Returns true iff the section and all linked parent sections have remaining enrollment slots.
 */
export function hasAvailableCapacity(section: NormalizedSection): boolean {
  if (section.activeClassSize >= section.maxClassSize) {
    return false;
  }
  return section.parentClass === null || hasAvailableCapacity(section.parentClass);
}

/**
 * Applies AMISync preprocessing filters:
 * 1. Drops TBA/asynchronous sections lacking fixed meeting schedules.
 * 2. Prunes zero-slot sections (`activeClassSize >= maxClassSize`) unless `isPreEnlisted` is true.
 */
export function filterAndPruneSections(
  sections: NormalizedSection[],
  options: { isPreEnlisted: boolean }
): {
  valid: NormalizedSection[];
  droppedTba: NormalizedSection[];
  droppedFull: NormalizedSection[];
} {
  const valid: NormalizedSection[] = [];
  const droppedTba: NormalizedSection[] = [];
  const droppedFull: NormalizedSection[] = [];

  for (const section of sections) {
    if (!hasFixedSchedule(section)) {
      droppedTba.push(section);
      continue;
    }

    if (!options.isPreEnlisted && !hasAvailableCapacity(section)) {
      droppedFull.push(section);
      continue;
    }

    valid.push(section);
  }

  return { valid, droppedTba, droppedFull };
}

function collectComponentsChain(section: NormalizedSection, set: Set<ComponentType>): void {
  if (section.parentClass) {
    collectComponentsChain(section.parentClass, set);
  }
  if (section.activity) {
    set.add(section.activity);
  }
}

/**
 * Derives unique required component types (e.g., `["LEC", "LAB"]`) across candidate sections,
 * ordering parent components before child components.
 */
export function deriveRequiredComponents(sections: NormalizedSection[]): ComponentType[] {
  const seen = new Set<ComponentType>();
  for (const section of sections) {
    collectComponentsChain(section, seen);
  }
  return Array.from(seen);
}

/**
 * Parses a raw AMIS course and its raw class list into a sorted, normalized `CourseEntry`.
 */
export function buildCourseEntryFromRaw(
  rawCourse: RawAmisCourse,
  rawClasses: RawAmisClass[],
  options?: { isPreEnlisted?: boolean; instanceId?: string; isExpanded?: boolean }
): CourseEntry {
  if (!Array.isArray(rawClasses)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Expected classes to be an array.');
  }

  const isPreEnlisted = Boolean(options?.isPreEnlisted);
  const course = parseRawCourse(rawCourse, options);

  const normalizedSections = rawClasses
    .map((rawClass) => parseRawClass(rawClass))
    .sort(compareSectionsCanonical);

  const sectionOptions: CourseSectionOption[] = normalizedSections.map((section) => ({
    section,
    flags: {
      isHidden: false,
      isLocked: false,
      isStarred: false,
    },
    isPreEnlisted,
  }));

  return {
    ...course,
    requiredComponents: deriveRequiredComponents(normalizedSections),
    sections: sectionOptions,
  };
}

/**
 * Evaluates a `CourseEntry` against TBA exclusion and capacity pruning rules,
 * exempting pre-enlisted courses/options from capacity pruning.
 */
export function checkExhaustedCapacity(course: CourseEntry): {
  exhausted: boolean;
  validOptions: CourseSectionOption[];
} {
  const validOptions: CourseSectionOption[] = [];

  for (const option of course.sections) {
    if (!hasFixedSchedule(option.section)) {
      continue;
    }
    const exempt = course.isPreEnlisted || option.isPreEnlisted;
    if (!exempt && !hasAvailableCapacity(option.section)) {
      continue;
    }
    validOptions.push(option);
  }

  return {
    exhausted: !course.isPreEnlisted && validOptions.length === 0,
    validOptions,
  };
}
