import type { RawAmisClass, RawAmisClassDate, RawAmisCourse } from '../types/amis.ts';
import type {
  ComponentType,
  CourseEntry,
  CourseSectionOption,
  FacultyName,
  NormalizedSection,
  NstpTrack,
  NstpTrackFilter,
  TimeslotInterval,
  Weekday,
} from '../types/domain.ts';
import { AmisError } from './errors.ts';

const TIME_12H_REGEX = /^(\d{1,2}):(\d{2})\s*([APap][Mm])$/;

export const DEFAULT_COMPONENT_TYPE: ComponentType = 'DEFAULT';
export const SUBCOMPONENT_TYPE: ComponentType = 'SUBCOMPONENT';

export const NSTP_TRACK_ORDER: readonly NstpTrack[] = ['CWTS', 'LTS', 'ROTC', 'Unlabeled'] as const;

const NSTP_TRACK_RANK: Readonly<Record<NstpTrack, number>> = {
  CWTS: 0,
  LTS: 1,
  ROTC: 2,
  Unlabeled: 3,
};

const CWTS_TRACK_REGEX =
  /(?:^|[^a-z])cwts(?=$|[^a-z])|\bcivic\s+welfare(?:\s+training\s+service)?\b/i;
const LTS_TRACK_REGEX =
  /(?:^|[^a-z])lts(?=$|[^a-z])|\bliteracy\s+training(?:\s+service)?\b/i;
const ROTC_TRACK_REGEX =
  /(?:^|[^a-z])rotc(?=$|[^a-z])|\breserve\s+officers?['’]?\s+training\s+corps\b/i;

const STANDARD_COMPONENT_MAP: Readonly<Record<string, ComponentType>> = {
  LEC: 'LEC',
  LECTURE: 'LEC',
  LAB: 'LAB',
  LABORATORY: 'LAB',
  RECIT: 'RECIT',
  RECITATION: 'RECIT',
  REC: 'RECIT',
  DISC: 'DISC',
  DISCUSSION: 'DISC',
};

/**
 * Normalizes a course code for canonical grouping (trim, collapse whitespace, uppercase).
 */
export function normalizeCourseCodeKey(code: string): string {
  return code.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Returns true if the given course code is an NSTP course (e.g., `"NSTP 1"`, `"NSTP 2"`, `"NSTP2"`).
 */
export function isNstpCourse(courseCode: string): boolean {
  const normalized = normalizeCourseCodeKey(courseCode);
  return /^NSTP(?:\b|\d)/.test(normalized);
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

function detectExplicitNstpTrackFromText(text: string | null | undefined): NstpTrack | null {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }
  const candidates: Array<{ track: NstpTrack; index: number }> = [];
  const cwtsMatch = CWTS_TRACK_REGEX.exec(text);
  if (cwtsMatch) {
    candidates.push({ track: 'CWTS', index: cwtsMatch.index });
  }
  const ltsMatch = LTS_TRACK_REGEX.exec(text);
  if (ltsMatch) {
    candidates.push({ track: 'LTS', index: ltsMatch.index });
  }
  const rotcMatch = ROTC_TRACK_REGEX.exec(text);
  if (rotcMatch) {
    candidates.push({ track: 'ROTC', index: rotcMatch.index });
  }
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0].track;
}

export interface NstpTrackClassificationInput {
  section?: string | null;
  activity?: string | null;
  subtitle?: string | null;
  sectionTitle?: string | null;
  courseSubtitle?: string | null;
  title?: string | null;
  courseTitle?: string | null;
  notes?: string | null;
  remarks?: string | null;
  description?: string | null;
  parentSection?: NormalizedSection | null;
}

/**
 * Classifies an NSTP section into `'CWTS'`, `'LTS'`, `'ROTC'`, or `'Unlabeled'` by inspecting
 * section naming conventions, activity/subtitle/title fields, notes, and parent sections.
 */
export function classifyNstpSectionTrack(input: NstpTrackClassificationInput): NstpTrack {
  const orderedFields: Array<string | null | undefined> = [
    input.sectionTitle,
    input.subtitle,
    input.courseSubtitle,
    input.activity,
    input.section,
    input.title,
    input.courseTitle,
    input.notes,
    input.remarks,
    input.description,
  ];

  for (const field of orderedFields) {
    const match = detectExplicitNstpTrackFromText(field);
    if (match !== null) {
      return match;
    }
  }

  if (input.parentSection) {
    if (
      input.parentSection.track === 'CWTS' ||
      input.parentSection.track === 'LTS' ||
      input.parentSection.track === 'ROTC'
    ) {
      return input.parentSection.track;
    }
    return classifyNstpSectionTrack({
      section: input.parentSection.section,
      activity: input.parentSection.activity,
      subtitle: input.parentSection.subtitle,
      notes: input.parentSection.notes,
      parentSection: input.parentSection.parentClass,
    });
  }

  return 'Unlabeled';
}

/**
 * Resolves the NSTP track (`'CWTS' | 'LTS' | 'ROTC' | 'Unlabeled'`) for a normalized section,
 * or returns `null` when `courseCode` is provided and is not an NSTP course.
 */
export function getSectionNstpTrack(
  section: NormalizedSection,
  courseCode?: string
): NstpTrack | null {
  if (courseCode !== undefined && !isNstpCourse(courseCode)) {
    return null;
  }
  if (
    section.track === 'CWTS' ||
    section.track === 'LTS' ||
    section.track === 'ROTC' ||
    section.track === 'Unlabeled'
  ) {
    return section.track;
  }
  return classifyNstpSectionTrack({
    section: section.section,
    activity: section.activity,
    subtitle: section.subtitle,
    notes: section.notes,
    parentSection: section.parentClass,
  });
}

/**
 * Maps standard UPLB AMIS structural component labels (`LEC`, `LAB`, `RECIT`, `DISC`)
 * to canonical component keys while collapsing empty values and free-text Special Topics
 * subtitles (e.g., `"Introduction to natural language processing"`) into `DEFAULT`.
 */
export function normalizeComponentType(activity: ComponentType | null | undefined): ComponentType {
  if (typeof activity !== 'string') {
    return DEFAULT_COMPONENT_TYPE;
  }
  const normalized = activity.trim().replace(/\s+/g, ' ').toUpperCase();
  if (!normalized) {
    return DEFAULT_COMPONENT_TYPE;
  }
  return STANDARD_COMPONENT_MAP[normalized] ?? DEFAULT_COMPONENT_TYPE;
}

/**
 * Returns true if the given component type is a recognized standard UPLB structural component
 * (as opposed to `DEFAULT` or `SUBCOMPONENT`).
 */
export function isStandardComponentType(component: ComponentType): boolean {
  return (
    component === 'LEC' ||
    component === 'LAB' ||
    component === 'RECIT' ||
    component === 'DISC'
  );
}

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

function parseOptionalTermId(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Parses a raw AMIS course object into a normalized `CourseEntry` shell.
 */
export function parseRawCourse(
  raw: unknown,
  options?: { isPreEnlisted?: boolean; instanceId?: string; isExpanded?: boolean; termId?: number | null }
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

  const resolvedTermId = parseOptionalTermId(options?.termId);
  const subtitle = firstNonEmptyString(
    raw.subtitle,
    raw.course_title,
    raw.title,
    raw.description
  );

  return {
    instanceId: options?.instanceId ?? crypto.randomUUID(),
    id: String(raw.course_id),
    code: raw.course_code.trim(),
    ...(resolvedTermId !== undefined ? { termId: resolvedTermId } : {}),
    ...(subtitle !== null ? { subtitle } : {}),
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
  visitedIds: Set<string> = new Set<string>(),
  options?: { termId?: number | null; courseCode?: string; courseSubtitle?: string | null }
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

  const resolvedTermId =
    parseOptionalTermId(options?.termId) ?? parseOptionalTermId(raw.term_id);

  const nestedRawCourse = isRecord(raw.course) ? raw.course : null;
  const resolvedCourseCode =
    options?.courseCode ??
    (nestedRawCourse && typeof nestedRawCourse.course_code === 'string'
      ? nestedRawCourse.course_code.trim()
      : undefined);

  const resolvedCourseSubtitle =
    options?.courseSubtitle ??
    (nestedRawCourse
      ? firstNonEmptyString(
          nestedRawCourse.subtitle,
          nestedRawCourse.course_title,
          nestedRawCourse.title,
          nestedRawCourse.description
        )
      : null);

  const parentClass =
    raw.parent !== null && raw.parent !== undefined
      ? parseRawClass(raw.parent, nextVisited, {
          ...(resolvedTermId !== undefined ? { termId: resolvedTermId } : {}),
          ...(resolvedCourseCode !== undefined ? { courseCode: resolvedCourseCode } : {}),
          ...(resolvedCourseSubtitle !== null ? { courseSubtitle: resolvedCourseSubtitle } : {}),
        })
      : null;

  const parentClassId = parentClass
    ? parentClass.id
    : hasValidId(raw.parent_class_id)
      ? String(raw.parent_class_id)
      : null;

  const sectionCode = raw.section.trim();
  const subtitle = firstNonEmptyString(
    raw.section_title,
    raw.subtitle,
    raw.course_subtitle,
    raw.title,
    raw.course_title,
    resolvedCourseSubtitle
  );
  const notes = firstNonEmptyString(raw.notes, raw.remarks, raw.description);

  const trackInput: NstpTrackClassificationInput = {
    section: sectionCode,
    activity,
    sectionTitle: firstNonEmptyString(raw.section_title),
    subtitle: firstNonEmptyString(raw.subtitle),
    courseSubtitle: firstNonEmptyString(raw.course_subtitle, resolvedCourseSubtitle),
    title: firstNonEmptyString(raw.title),
    courseTitle: firstNonEmptyString(raw.course_title),
    notes: firstNonEmptyString(raw.notes),
    remarks: firstNonEmptyString(raw.remarks),
    description: firstNonEmptyString(raw.description),
    parentSection: parentClass,
  };

  let track: NstpTrack | undefined;
  if (resolvedCourseCode !== undefined && isNstpCourse(resolvedCourseCode)) {
    track = classifyNstpSectionTrack(trackInput);
  } else if (resolvedCourseCode === undefined) {
    const explicit = classifyNstpSectionTrack(trackInput);
    if (explicit === 'CWTS' || explicit === 'LTS' || explicit === 'ROTC') {
      track = explicit;
    }
  }

  return {
    id,
    courseId: String(raw.course_id),
    ...(resolvedTermId !== undefined ? { termId: resolvedTermId } : {}),
    section: sectionCode,
    activity,
    faculties: parseFaculties(raw),
    location,
    dates: parseClassDates(raw.class_dates),
    activeClassSize: raw.active_class_size,
    maxClassSize: raw.max_class_size,
    isPrerogOpen: Boolean(raw.is_prerog_open),
    parentClassId,
    parentClass,
    ...(subtitle !== null ? { subtitle } : {}),
    ...(notes !== null ? { notes } : {}),
    ...(track !== undefined ? { track } : {}),
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
 * Deterministic NSTP section comparator:
 * orders tracks CWTS -> LTS -> ROTC -> Unlabeled, then alphabetically/naturally by section code within each track.
 */
export function compareNstpSections(a: NormalizedSection, b: NormalizedSection): number {
  const trackA = getSectionNstpTrack(a) ?? 'Unlabeled';
  const trackB = getSectionNstpTrack(b) ?? 'Unlabeled';
  const rankDiff = NSTP_TRACK_RANK[trackA] - NSTP_TRACK_RANK[trackB];
  if (rankDiff !== 0) {
    return rankDiff;
  }
  const sectionCmp = a.section.localeCompare(b.section, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (sectionCmp !== 0) {
    return sectionCmp;
  }
  const exactCmp = a.section.localeCompare(b.section);
  if (exactCmp !== 0) {
    return exactCmp;
  }
  return a.id.localeCompare(b.id);
}

/**
 * Returns section options sorted deterministically by NSTP track (`CWTS` -> `LTS` -> `ROTC` -> `Unlabeled`)
 * and section code for NSTP courses, or a shallow copy preserving existing order otherwise.
 */
export function sortCourseSectionsForDisplay(
  options: readonly CourseSectionOption[],
  courseCode: string
): CourseSectionOption[] {
  if (!isNstpCourse(courseCode)) {
    return [...options];
  }
  return [...options].sort((a, b) => compareNstpSections(a.section, b.section));
}

/**
 * Computes per-track section counts (`All`, `CWTS`, `LTS`, `ROTC`, `Unlabeled`) for an NSTP course.
 */
export function computeNstpTrackCounts(
  options: readonly CourseSectionOption[],
  courseCode: string
): Record<NstpTrackFilter, number> {
  const counts: Record<NstpTrackFilter, number> = {
    All: options.length,
    CWTS: 0,
    LTS: 0,
    ROTC: 0,
    Unlabeled: 0,
  };
  for (const opt of options) {
    const track = getSectionNstpTrack(opt.section, courseCode) ?? 'Unlabeled';
    counts[track] += 1;
  }
  return counts;
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
  let parentComponent: ComponentType | null = null;
  if (section.parentClass) {
    collectComponentsChain(section.parentClass, set);
    parentComponent = normalizeComponentType(section.parentClass.activity);
  }
  let comp = normalizeComponentType(section.activity);
  if (parentComponent !== null && comp === parentComponent && !isStandardComponentType(comp)) {
    comp = SUBCOMPONENT_TYPE;
  }
  set.add(comp);
}

/**
 * Derives unique normalized structural component types (e.g., `["LEC", "LAB"]`, or `["DEFAULT"]`
 * for Special Topics courses whose `activity` stores per-section topic subtitles),
 * ordering parent components before child components.
 */
export function deriveRequiredComponents(sections: NormalizedSection[]): ComponentType[] {
  const seen = new Set<ComponentType>();
  for (const section of sections) {
    collectComponentsChain(section, seen);
  }
  if (seen.has('LEC') && seen.has(DEFAULT_COMPONENT_TYPE)) {
    const hasChildDefault = sections.some(
      (s) =>
        (s.parentClass !== null || s.parentClassId !== null) &&
        normalizeComponentType(s.activity) === DEFAULT_COMPONENT_TYPE
    );
    if (!hasChildDefault) {
      seen.delete(DEFAULT_COMPONENT_TYPE);
    }
  }
  return Array.from(seen);
}

/**
 * Parses a raw AMIS course and its raw class list into a sorted, normalized `CourseEntry`.
 */
export function buildCourseEntryFromRaw(
  rawCourse: RawAmisCourse,
  rawClasses: RawAmisClass[],
  options?: { isPreEnlisted?: boolean; instanceId?: string; isExpanded?: boolean; termId?: number | null }
): CourseEntry {
  if (!Array.isArray(rawClasses)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Expected classes to be an array.');
  }

  const isPreEnlisted = Boolean(options?.isPreEnlisted);
  const course = parseRawCourse(rawCourse, options);
  const resolvedTermId = parseOptionalTermId(options?.termId) ?? course.termId;
  const isNstp = isNstpCourse(course.code);

  const normalizedSections = rawClasses
    .map((rawClass) =>
      parseRawClass(rawClass, new Set<string>(), {
        ...(resolvedTermId !== undefined ? { termId: resolvedTermId } : {}),
        courseCode: course.code,
        ...(course.subtitle !== undefined ? { courseSubtitle: course.subtitle } : {}),
      })
    )
    .sort(isNstp ? compareNstpSections : compareSectionsCanonical);

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
