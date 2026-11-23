import type {
  RawAmisClass,
  RawAmisCourse,
  RawStudentEnlistmentClass,
} from '../types/amis.ts';
import type { CourseEntry } from '../types/domain.ts';
import type { ChromeBridgeApi } from './bridge.ts';
import { executeInActiveAmisTab } from './bridge.ts';
import { AmisError } from './errors.ts';
import { buildCourseEntryFromRaw } from './parser.ts';

export interface AmisHttpResult {
  ok: boolean;
  status: number;
  body: unknown;
  parseError?: boolean;
  networkError?: string;
}

/**
 * Abstract read-only HTTP transport for AMIS API calls, injectable for unit testing.
 */
export type AmisHttpExecutor = (pathWithQuery: string, token: string) => Promise<AmisHttpResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Creates a read-only AMIS HTTP executor that runs `fetch(..., { method: 'GET' })` inside
 * the active AMIS tab so requests inherit the exact `https://amis.up*.edu.ph` Origin header.
 */
export function createTabAmisExecutor(chromeApi?: ChromeBridgeApi): AmisHttpExecutor {
  return async (pathWithQuery: string, token: string): Promise<AmisHttpResult> => {
    return executeInActiveAmisTab(
      // Must remain completely self-contained for MV3 executeScript serialization.
      async (path: string, authHeader: string): Promise<AmisHttpResult> => {
        const match = window.location.href.match(/https?:\/\/(amis\.up.*\.edu\.ph)/);
        if (!match || !match[1]) {
          return {
            ok: false,
            status: 0,
            body: null,
            networkError: 'Script must be run on an AMIS website (amis.up*.edu.ph).',
          };
        }

        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          return {
            ok: false,
            status: 0,
            body: null,
            networkError: 'Browser is offline. Unable to reach UPLB AMIS.',
          };
        }

        const apiBase = `https://api-${match[1]}`;
        try {
          const response = await fetch(`${apiBase}${path}`, {
            method: 'GET',
            headers: {
              Authorization: authHeader,
            },
          });

          const text = await response.text();
          if (!text) {
            return {
              ok: response.ok,
              status: response.status,
              body: null,
              parseError: response.ok,
            };
          }

          try {
            const body: unknown = JSON.parse(text);
            return {
              ok: response.ok,
              status: response.status,
              body,
            };
          } catch {
            return {
              ok: response.ok,
              status: response.status,
              body: null,
              parseError: true,
            };
          }
        } catch (err) {
          return {
            ok: false,
            status: 0,
            body: null,
            networkError: err instanceof Error ? err.message : 'Network request failed.',
          };
        }
      },
      [pathWithQuery, token],
      chromeApi
    );
  };
}

function resolveExecutor(executor?: AmisHttpExecutor): AmisHttpExecutor {
  return executor ?? createTabAmisExecutor();
}

async function requestAmisJson(
  pathWithQuery: string,
  token: string,
  executor?: AmisHttpExecutor
): Promise<Record<string, unknown>> {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new AmisError(
      'UNAUTHENTICATED',
      'You are not authenticated. Open AMISync over a logged-in AMIS website.'
    );
  }

  const run = resolveExecutor(executor);
  let result: AmisHttpResult;
  try {
    result = await run(pathWithQuery, token);
  } catch (err) {
    if (err instanceof AmisError) {
      throw err;
    }
    throw new AmisError(
      'NETWORK_ERROR',
      err instanceof Error ? err.message : 'Failed to communicate with AMIS.',
      { details: err }
    );
  }

  if (result.networkError) {
    throw new AmisError('NETWORK_ERROR', result.networkError);
  }

  if (result.status === 401 || result.status === 403) {
    throw new AmisError(
      'SESSION_EXPIRED',
      'Your AMIS session has expired. Please refresh or sign back in to AMIS.',
      { statusCode: result.status }
    );
  }

  if (!result.ok) {
    throw new AmisError(
      'NETWORK_ERROR',
      `AMIS API request failed with HTTP ${result.status}.`,
      { statusCode: result.status, details: result.body }
    );
  }

  if (result.parseError || !isRecord(result.body)) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      `AMIS API returned malformed JSON for ${pathWithQuery}.`
    );
  }

  return result.body;
}

/**
 * Normalizes a course code query string by collapsing whitespace and URL-encoding spaces as `+`
 * (e.g., `"  CMSC   128 "` -> `"CMSC+128"`).
 */
export function normalizeCourseSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed
    .split(/\s+/)
    .map((part) => encodeURIComponent(part))
    .join('+');
}

/**
 * Endpoint 1: `GET /api/scheduled-features/student_enlistment?role=student`
 * Resolves `nextSchedule?.term_id ?? activeTerm.term_id`.
 */
export async function fetchActiveTermId(
  token: string,
  executor?: AmisHttpExecutor
): Promise<number> {
  const body = await requestAmisJson(
    '/api/scheduled-features/student_enlistment?role=student',
    token,
    executor
  );

  const nextSchedule = isRecord(body.nextSchedule) ? body.nextSchedule : null;
  const activeTerm = isRecord(body.activeTerm) ? body.activeTerm : null;
  const rawTermId = nextSchedule?.term_id ?? activeTerm?.term_id;

  if (typeof rawTermId !== 'number' || !Number.isFinite(rawTermId)) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      'AMIS term schedule response is missing a valid term_id.'
    );
  }

  return rawTermId;
}

/**
 * Endpoint 2: `GET /api/courses?course_code_like=${query}`
 */
export async function searchCoursesByCode(
  token: string,
  query: string,
  executor?: AmisHttpExecutor
): Promise<RawAmisCourse[]> {
  const encodedQuery = normalizeCourseSearchQuery(query);
  if (!encodedQuery) {
    return [];
  }

  const body = await requestAmisJson(
    `/api/courses?course_code_like=${encodedQuery}`,
    token,
    executor
  );

  if (!Array.isArray(body.courses)) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      'AMIS course search response is missing a courses array.'
    );
  }

  return body.courses as RawAmisCourse[];
}

/**
 * Endpoint 3: `GET /api/students/classes?status=Active&by_term_type=true&term_id=...&course_id=...`
 */
export async function fetchCourseClasses(
  token: string,
  termId: number,
  courseId: string | number,
  executor?: AmisHttpExecutor
): Promise<RawAmisClass[]> {
  if (!Number.isFinite(termId)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Invalid termId provided for class fetch.');
  }

  const encodedCourseId = encodeURIComponent(String(courseId));
  const body = await requestAmisJson(
    `/api/students/classes?status=Active&by_term_type=true&term_id=${termId}&course_id=${encodedCourseId}`,
    token,
    executor
  );

  if (!Array.isArray(body.classes)) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      'AMIS classes response is missing a classes array.'
    );
  }

  return body.classes as RawAmisClass[];
}

/**
 * Searches for an exact course code match (case-insensitive), queries all duplicate `course_id`
 * records in parallel via Endpoint 3, selects the first with non-empty classes, and normalizes
 * into a `CourseEntry`.
 */
export async function fetchCourseWithClasses(
  token: string,
  termId: number,
  courseCode: string,
  executor?: AmisHttpExecutor
): Promise<CourseEntry> {
  const normalizedTarget = courseCode.trim().replace(/\s+/g, ' ').toUpperCase();
  if (!normalizedTarget) {
    throw new AmisError('COURSE_NOT_FOUND', 'Course not found');
  }

  const candidates = await searchCoursesByCode(token, normalizedTarget, executor);
  const exactMatches = candidates.filter(
    (course) =>
      typeof course?.course_code === 'string' &&
      course.course_code.trim().replace(/\s+/g, ' ').toUpperCase() === normalizedTarget
  );

  if (exactMatches.length === 0) {
    throw new AmisError('COURSE_NOT_FOUND', `Course not found: ${courseCode.trim()}`);
  }

  const classLists = await Promise.all(
    exactMatches.map((course) => fetchCourseClasses(token, termId, course.course_id, executor))
  );

  const nonEmptyIndex = classLists.findIndex((classes) => classes.length > 0);
  if (nonEmptyIndex === -1) {
    throw new AmisError('NO_CLASSES_FOUND', `Course has no classes: ${courseCode.trim()}`);
  }

  return buildCourseEntryFromRaw(exactMatches[nonEmptyIndex], classLists[nonEmptyIndex], {
    isPreEnlisted: false,
  });
}

/**
 * Endpoint 4: `GET /api/auth/user`
 * Resolves `user.id` required by Endpoint 5.
 */
export async function fetchAuthUserId(
  token: string,
  executor?: AmisHttpExecutor
): Promise<string> {
  const body = await requestAmisJson('/api/auth/user', token, executor);
  const user = isRecord(body.user) ? body.user : null;
  const userId = user?.id;

  if (
    userId === undefined ||
    userId === null ||
    (typeof userId !== 'number' && typeof userId !== 'string') ||
    String(userId).trim() === ''
  ) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      'AMIS auth user response is missing a valid user.id.'
    );
  }

  return String(userId);
}

interface GroupedEnlistmentBucket {
  course: RawAmisCourse;
  classes: RawAmisClass[];
}

function groupEnlistmentItems(
  items: RawStudentEnlistmentClass[],
  isPreEnlisted: boolean
): CourseEntry[] {
  const byCourseId = new Map<string, GroupedEnlistmentBucket>();

  for (const item of items) {
    const rawClass = item.class;
    const rawCourse = rawClass.course;
    const courseId = String(rawCourse.course_id);
    const existing = byCourseId.get(courseId);
    if (existing) {
      existing.classes.push(rawClass);
    } else {
      byCourseId.set(courseId, {
        course: rawCourse,
        classes: [rawClass],
      });
    }
  }

  return Array.from(byCourseId.values()).map(({ course, classes }) =>
    buildCourseEntryFromRaw(course, classes, { isPreEnlisted })
  );
}

/**
 * Endpoint 5: `GET /api/students/enlistments?enlistment_user_id=...&by_term_type=true&term_id=...&enlistedClasses=true`
 * Splits `"Enlisted"` / `"Sent to SAIS"` into `preEnlistedCourses` and `"Bookmarked"` into `bookmarkedCourses`.
 */
export async function fetchStudentEnlistments(
  token: string,
  termId: number,
  userId: string | number,
  executor?: AmisHttpExecutor
): Promise<{ preEnlistedCourses: CourseEntry[]; bookmarkedCourses: CourseEntry[] }> {
  if (!Number.isFinite(termId)) {
    throw new AmisError('MALFORMED_RESPONSE', 'Invalid termId provided for enlistment fetch.');
  }

  const encodedUserId = encodeURIComponent(String(userId));
  const body = await requestAmisJson(
    `/api/students/enlistments?enlistment_user_id=${encodedUserId}&by_term_type=true&term_id=${termId}&enlistedClasses=true`,
    token,
    executor
  );

  if (!Array.isArray(body.enlistments)) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      'AMIS enlistments response is missing an enlistments array.'
    );
  }

  if (body.enlistments.length === 0) {
    return { preEnlistedCourses: [], bookmarkedCourses: [] };
  }

  const firstEnlistment = body.enlistments[0];
  if (!isRecord(firstEnlistment) || !Array.isArray(firstEnlistment.student_enlistment_classes)) {
    throw new AmisError(
      'MALFORMED_RESPONSE',
      'AMIS enlistment entry is missing student_enlistment_classes.'
    );
  }

  const preEnlistedItems: RawStudentEnlistmentClass[] = [];
  const bookmarkedItems: RawStudentEnlistmentClass[] = [];

  for (const item of firstEnlistment.student_enlistment_classes) {
    if (!isRecord(item) || !isRecord(item.class) || !isRecord(item.class.course)) {
      throw new AmisError(
        'MALFORMED_RESPONSE',
        'Malformed student_enlistment_classes record in AMIS enlistments response.'
      );
    }

    const typedItem = item as unknown as RawStudentEnlistmentClass;
    if (typedItem.status === 'Enlisted' || typedItem.status === 'Sent to SAIS') {
      preEnlistedItems.push(typedItem);
    } else if (typedItem.status === 'Bookmarked') {
      bookmarkedItems.push(typedItem);
    }
  }

  return {
    preEnlistedCourses: groupEnlistmentItems(preEnlistedItems, true),
    bookmarkedCourses: groupEnlistmentItems(bookmarkedItems, false),
  };
}
