import {
  WEEKDAYS,
  type AcademicPlanState,
  type CourseEntry,
  type NormalizedSection,
  type PreferencePriority,
  type Weekday,
} from '../types/domain.ts';
import { PLAN_SCHEMA_VERSION } from '../types/domain.ts';
import { AmisError } from './errors.ts';

export type ScalabilityTier = 'Small' | 'Medium' | 'Large';

/**
 * Self-contained anonymized JSON snapshot envelope for reproducible offline benchmarking.
 */
export interface AmisPlanSnapshot {
  schemaVersion: string;
  capturedAt: string;
  tier?: ScalabilityTier;
  plan: AcademicPlanState;
}

const VALID_WEEKDAYS = new Set<string>(WEEKDAYS);
const VALID_PRIORITIES = new Set<PreferencePriority>(['Off', 'Low', 'Medium', 'High']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateNormalizedSection(
  rawSection: unknown,
  path: string,
  visitedIds: Set<string> = new Set<string>()
): NormalizedSection {
  if (!isRecord(rawSection)) {
    throw new AmisError('MALFORMED_RESPONSE', `${path} must be an object.`);
  }
  if (!isNonEmptyString(rawSection.id)) {
    throw new AmisError('MALFORMED_RESPONSE', `${path}.id must be a non-empty string.`);
  }
  if (visitedIds.has(rawSection.id)) {
    throw new AmisError('MALFORMED_RESPONSE', `${path} contains a circular parentClass reference.`);
  }
  if (!isNonEmptyString(rawSection.courseId) || !isNonEmptyString(rawSection.section)) {
    throw new AmisError('MALFORMED_RESPONSE', `${path} is missing valid courseId or section.`);
  }
  if (rawSection.activity !== null && typeof rawSection.activity !== 'string') {
    throw new AmisError('MALFORMED_RESPONSE', `${path}.activity must be string or null.`);
  }
  if (rawSection.location !== null && typeof rawSection.location !== 'string') {
    throw new AmisError('MALFORMED_RESPONSE', `${path}.location must be string or null.`);
  }
  if (!Array.isArray(rawSection.faculties)) {
    throw new AmisError('MALFORMED_RESPONSE', `${path}.faculties must be an array.`);
  }
  for (const f of rawSection.faculties) {
    if (
      !isRecord(f) ||
      typeof f.firstName !== 'string' ||
      typeof f.middleName !== 'string' ||
      typeof f.lastName !== 'string'
    ) {
      throw new AmisError('MALFORMED_RESPONSE', `${path}.faculties contains an invalid entry.`);
    }
  }
  if (!Array.isArray(rawSection.dates)) {
    throw new AmisError('MALFORMED_RESPONSE', `${path}.dates must be an array.`);
  }
  for (const interval of rawSection.dates) {
    if (
      !isRecord(interval) ||
      !Array.isArray(interval.days) ||
      interval.days.some((d) => typeof d !== 'string' || !VALID_WEEKDAYS.has(d)) ||
      typeof interval.startTime !== 'string' ||
      typeof interval.endTime !== 'string' ||
      !isFiniteNumber(interval.startMinutes) ||
      !isFiniteNumber(interval.endMinutes) ||
      interval.startMinutes < 0 ||
      interval.endMinutes > 1440 ||
      interval.startMinutes >= interval.endMinutes
    ) {
      throw new AmisError('MALFORMED_RESPONSE', `${path}.dates contains an invalid TimeslotInterval.`);
    }
  }
  if (!isFiniteNumber(rawSection.activeClassSize) || !isFiniteNumber(rawSection.maxClassSize)) {
    throw new AmisError('MALFORMED_RESPONSE', `${path} has invalid class size bounds.`);
  }
  if (typeof rawSection.isPrerogOpen !== 'boolean') {
    throw new AmisError('MALFORMED_RESPONSE', `${path}.isPrerogOpen must be a boolean.`);
  }
  if (rawSection.parentClassId !== null && typeof rawSection.parentClassId !== 'string') {
    throw new AmisError('MALFORMED_RESPONSE', `${path}.parentClassId must be string or null.`);
  }
  if (rawSection.parentClass !== null) {
    const nextVisited = new Set(visitedIds);
    nextVisited.add(rawSection.id);
    validateNormalizedSection(rawSection.parentClass, `${path}.parentClass`, nextVisited);
  }
  return rawSection as unknown as NormalizedSection;
}

function validateCourseEntryList(entries: unknown, fieldName: string): CourseEntry[] {
  if (!Array.isArray(entries)) {
    throw new AmisError('MALFORMED_RESPONSE', `Snapshot plan.${fieldName} must be an array.`);
  }

  entries.forEach((entry, idx) => {
    const prefix = `plan.${fieldName}[${idx}]`;
    if (
      !isRecord(entry) ||
      !isNonEmptyString(entry.instanceId) ||
      !isNonEmptyString(entry.id) ||
      !isNonEmptyString(entry.code) ||
      !isFiniteNumber(entry.units) ||
      entry.units < 0 ||
      typeof entry.canEnrollMultiple !== 'boolean' ||
      typeof entry.isPreEnlisted !== 'boolean' ||
      typeof entry.isExpanded !== 'boolean' ||
      !Array.isArray(entry.requiredComponents) ||
      entry.requiredComponents.some((c) => typeof c !== 'string') ||
      !Array.isArray(entry.sections)
    ) {
      throw new AmisError(
        'MALFORMED_RESPONSE',
        `Snapshot ${prefix} contains an invalid CourseEntry.`
      );
    }

    entry.sections.forEach((opt, optIdx) => {
      const optPath = `${prefix}.sections[${optIdx}]`;
      if (
        !isRecord(opt) ||
        typeof opt.isPreEnlisted !== 'boolean' ||
        !isRecord(opt.flags) ||
        typeof opt.flags.isHidden !== 'boolean' ||
        typeof opt.flags.isLocked !== 'boolean' ||
        typeof opt.flags.isStarred !== 'boolean'
      ) {
        throw new AmisError('MALFORMED_RESPONSE', `${optPath} is malformed.`);
      }
      validateNormalizedSection(opt.section, `${optPath}.section`);
    });
  });

  return entries as unknown as CourseEntry[];
}

function validatePriority(value: unknown, fieldName: string): void {
  if (typeof value !== 'string' || !VALID_PRIORITIES.has(value as PreferencePriority)) {
    throw new AmisError('MALFORMED_RESPONSE', `Plan payload ${fieldName} has invalid priority.`);
  }
}

function validatePreferences(rawPrefs: unknown): void {
  if (!isRecord(rawPrefs)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Plan payload preferences must be an object.');
  }

  const {
    fatigueLimit,
    acceptableDayBounds,
    minimizeFridayClasses,
    batchSubjectsToFewerDays,
    minimizeExcessiveGaps,
    starredSectionPreference,
  } = rawPrefs;

  if (
    !isRecord(fatigueLimit) ||
    !isFiniteNumber(fatigueLimit.maxConsecutiveHours) ||
    fatigueLimit.maxConsecutiveHours < 1 ||
    fatigueLimit.maxConsecutiveHours > 12
  ) {
    throw new AmisError('MALFORMED_RESPONSE', 'Plan payload preferences.fatigueLimit is invalid.');
  }
  validatePriority(fatigueLimit.priority, 'preferences.fatigueLimit.priority');

  if (
    !isRecord(acceptableDayBounds) ||
    !isFiniteNumber(acceptableDayBounds.earliestStartMinutes) ||
    !isFiniteNumber(acceptableDayBounds.latestEndMinutes) ||
    acceptableDayBounds.earliestStartMinutes < 420 ||
    acceptableDayBounds.latestEndMinutes > 1140 ||
    acceptableDayBounds.earliestStartMinutes > acceptableDayBounds.latestEndMinutes
  ) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      'Plan payload preferences.acceptableDayBounds is invalid.'
    );
  }
  validatePriority(acceptableDayBounds.priority, 'preferences.acceptableDayBounds.priority');

  if (!isRecord(minimizeFridayClasses)) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      'Plan payload preferences.minimizeFridayClasses is invalid.'
    );
  }
  validatePriority(
    minimizeFridayClasses.priority,
    'preferences.minimizeFridayClasses.priority'
  );

  if (!isRecord(batchSubjectsToFewerDays)) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      'Plan payload preferences.batchSubjectsToFewerDays is invalid.'
    );
  }
  validatePriority(
    batchSubjectsToFewerDays.priority,
    'preferences.batchSubjectsToFewerDays.priority'
  );

  if (!isRecord(minimizeExcessiveGaps) || minimizeExcessiveGaps.gapThresholdMinutes !== 120) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      'Plan payload preferences.minimizeExcessiveGaps is invalid.'
    );
  }
  validatePriority(
    minimizeExcessiveGaps.priority,
    'preferences.minimizeExcessiveGaps.priority'
  );

  if (!isRecord(starredSectionPreference)) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      'Plan payload preferences.starredSectionPreference is invalid.'
    );
  }
  validatePriority(
    starredSectionPreference.priority,
    'preferences.starredSectionPreference.priority'
  );
}

/**
 * Validates that an unknown object deeply conforms to the `AcademicPlanState` schema
 * so corrupted or stale storage payloads are safely rejected.
 */
export function validateAcademicPlanState(rawPlan: unknown): AcademicPlanState {
  if (!isRecord(rawPlan)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Plan payload must be an object.');
  }
  if (!isNonEmptyString(rawPlan.schemaVersion)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Plan payload is missing schemaVersion.');
  }
  if (rawPlan.termId !== null && !isFiniteNumber(rawPlan.termId)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Plan payload termId must be a finite number or null.');
  }
  if (rawPlan.lastRefreshTime !== null && typeof rawPlan.lastRefreshTime !== 'string') {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      'Plan payload lastRefreshTime must be a string or null.'
    );
  }

  validateCourseEntryList(rawPlan.preEnlistedCourses, 'preEnlistedCourses');
  validateCourseEntryList(rawPlan.intendedCourses, 'intendedCourses');

  if (!Array.isArray(rawPlan.blockedCells)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Plan payload blockedCells must be an array.');
  }
  for (const cell of rawPlan.blockedCells) {
    if (
      !isRecord(cell) ||
      !isNonEmptyString(cell.id) ||
      typeof cell.day !== 'string' ||
      !VALID_WEEKDAYS.has(cell.day as Weekday) ||
      !isFiniteNumber(cell.startMinutes) ||
      !isFiniteNumber(cell.endMinutes) ||
      cell.startMinutes < 0 ||
      cell.endMinutes > 1440 ||
      cell.startMinutes >= cell.endMinutes
    ) {
      throw new AmisError('MALFORMED_RESPONSE', 'Plan payload blockedCells contains an invalid cell.');
    }
  }

  validatePreferences(rawPlan.preferences);

  if (
    !isRecord(rawPlan.diversity) ||
    !isFiniteNumber(rawPlan.diversity.maxAlternatives) ||
    rawPlan.diversity.maxAlternatives < 1 ||
    !isFiniteNumber(rawPlan.diversity.minDifferingSections) ||
    rawPlan.diversity.minDifferingSections < 1 ||
    !isFiniteNumber(rawPlan.diversity.minHammingDistance) ||
    rawPlan.diversity.minHammingDistance < 2 ||
    typeof rawPlan.diversity.alternatePreferenceProfiles !== 'boolean'
  ) {
    throw new AmisError('MALFORMED_RESPONSE', 'Plan payload diversity config is invalid.');
  }

  if (rawPlan.unitLimits !== undefined) {
    if (!isRecord(rawPlan.unitLimits)) {
      throw new AmisError('MALFORMED_RESPONSE', 'Plan payload unitLimits must be an object.');
    }
    if (rawPlan.unitLimits.minUnits !== undefined && !isFiniteNumber(rawPlan.unitLimits.minUnits)) {
      throw new AmisError('MALFORMED_RESPONSE', 'Plan payload unitLimits.minUnits must be finite.');
    }
    if (rawPlan.unitLimits.maxUnits !== undefined && !isFiniteNumber(rawPlan.unitLimits.maxUnits)) {
      throw new AmisError('MALFORMED_RESPONSE', 'Plan payload unitLimits.maxUnits must be finite.');
    }
  }

  return rawPlan as unknown as AcademicPlanState;
}

/**
 * Serializes an `AcademicPlanState` into a formatted static JSON snapshot string.
 */
export function exportPlanSnapshot(
  plan: AcademicPlanState,
  options?: { tier?: ScalabilityTier; capturedAt?: string }
): string {
  const validated = validateAcademicPlanState(plan);
  const snapshot: AmisPlanSnapshot = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    capturedAt: options?.capturedAt ?? new Date().toISOString(),
    ...(options?.tier ? { tier: options.tier } : {}),
    plan: validated,
  };
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Parses and validates a static JSON snapshot string or object into an `AmisPlanSnapshot`.
 */
export function parsePlanSnapshot(input: string | unknown): AmisPlanSnapshot {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new AmisError('MALFORMED_RESPONSE', 'Snapshot contains invalid JSON.');
    }
  }

  if (!isRecord(parsed)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Snapshot root must be an object.');
  }
  if (typeof parsed.schemaVersion !== 'string' || parsed.schemaVersion.trim() === '') {
    throw new AmisError('MALFORMED_RESPONSE', 'Snapshot is missing schemaVersion.');
  }
  if (typeof parsed.capturedAt !== 'string' || parsed.capturedAt.trim() === '') {
    throw new AmisError('MALFORMED_RESPONSE', 'Snapshot is missing capturedAt.');
  }
  if (
    parsed.tier !== undefined &&
    parsed.tier !== 'Small' &&
    parsed.tier !== 'Medium' &&
    parsed.tier !== 'Large'
  ) {
    throw new AmisError('MALFORMED_RESPONSE', 'Snapshot tier must be Small, Medium, or Large.');
  }

  const plan = validateAcademicPlanState(parsed.plan);

  return {
    schemaVersion: parsed.schemaVersion,
    capturedAt: parsed.capturedAt,
    ...(parsed.tier ? { tier: parsed.tier } : {}),
    plan,
  };
}
