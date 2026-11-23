import type { AcademicPlanState, CourseEntry } from '../types/domain.ts';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCourseEntryList(entries: unknown, fieldName: string): CourseEntry[] {
  if (!Array.isArray(entries)) {
    throw new AmisError('MALFORMED_RESPONSE', `Snapshot plan.${fieldName} must be an array.`);
  }

  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      typeof entry.code !== 'string' ||
      typeof entry.units !== 'number' ||
      !Number.isFinite(entry.units) ||
      !Array.isArray(entry.sections)
    ) {
      throw new AmisError(
        'MALFORMED_RESPONSE',
        `Snapshot plan.${fieldName} contains an invalid CourseEntry.`
      );
    }
  }

  return entries as unknown as CourseEntry[];
}

/**
 * Validates that an unknown object conforms to the `AcademicPlanState` schema.
 */
export function validateAcademicPlanState(rawPlan: unknown): AcademicPlanState {
  if (!isRecord(rawPlan)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Plan payload must be an object.');
  }
  if (typeof rawPlan.schemaVersion !== 'string' || rawPlan.schemaVersion.trim() === '') {
    throw new AmisError('MALFORMED_RESPONSE', 'Plan payload is missing schemaVersion.');
  }

  validateCourseEntryList(rawPlan.preEnlistedCourses, 'preEnlistedCourses');
  validateCourseEntryList(rawPlan.intendedCourses, 'intendedCourses');

  if (!Array.isArray(rawPlan.blockedCells)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Plan payload blockedCells must be an array.');
  }
  if (!isRecord(rawPlan.preferences)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Plan payload preferences must be an object.');
  }
  if (!isRecord(rawPlan.diversity)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Plan payload diversity must be an object.');
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
