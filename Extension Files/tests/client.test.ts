import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChromeBridgeApi } from '../src/amis/bridge.ts';
import {
  deriveApiBaseFromHref,
  extractAuthTokenFromCookieString,
  getActiveAmisTab,
  isAmisUrl,
  subscribeAuthTokenSync,
} from '../src/amis/bridge.ts';
import type { AmisHttpExecutor, AmisHttpResult } from '../src/amis/client.ts';
import {
  fetchActiveTermId,
  fetchAuthUserId,
  fetchCourseWithClasses,
  fetchStudentEnlistments,
  normalizeCourseSearchQuery,
} from '../src/amis/client.ts';
import { isAmisError } from '../src/amis/errors.ts';
import type { RawAmisClass, RawAmisCourse } from '../src/types/amis.ts';

function makeRawClass(overrides: Partial<RawAmisClass> = {}): RawAmisClass {
  return {
    id: 201,
    course_id: 500,
    section: 'AB-1L',
    activity: 'LAB',
    hide_faculty: false,
    faculties: [],
    facility_id: 'ICS PC1',
    class_dates: [
      {
        mon: false,
        tue: false,
        wed: false,
        thu: true,
        fri: false,
        sat: false,
        start_time: '01:00 PM',
        end_time: '04:00 PM',
      },
    ],
    active_class_size: 10,
    max_class_size: 25,
    is_prerog_open: false,
    parent: {
      id: 101,
      course_id: 500,
      section: 'AB',
      activity: 'LEC',
      hide_faculty: false,
      faculties: [],
      facility_id: 'ICS LH3',
      class_dates: [
        {
          mon: false,
          tue: true,
          wed: false,
          thu: true,
          fri: false,
          sat: false,
          start_time: '08:00 AM',
          end_time: '09:00 AM',
        },
      ],
      active_class_size: 40,
      max_class_size: 60,
      is_prerog_open: false,
      parent: null,
    },
    ...overrides,
  };
}

describe('AMIS Bridge & Auth Cookie Helpers', () => {
  it('validates UP AMIS URLs and derives origin-matched API base', () => {
    assert.equal(isAmisUrl('https://amis.uplb.edu.ph/enlistment'), true);
    assert.equal(isAmisUrl('https://amis.upm.edu.ph/'), true);
    assert.equal(isAmisUrl('https://google.com/'), false);
    assert.equal(isAmisUrl(undefined), false);

    assert.equal(
      deriveApiBaseFromHref('https://amis.uplb.edu.ph/student/enlistment'),
      'https://api-amis.uplb.edu.ph'
    );
    assert.throws(
      () => deriveApiBaseFromHref('https://example.com'),
      (err: unknown) => isAmisError(err) && err.code === 'NOT_ON_AMIS_TAB'
    );
  });

  it('extracts auth._token.local verbatim including = padding and handles false/missing', () => {
    assert.equal(
      extractAuthTokenFromCookieString('foo=bar; auth._token.local=Bearer%20abc.def.ghi==; baz=1'),
      'Bearer abc.def.ghi=='
    );
    assert.equal(extractAuthTokenFromCookieString('auth._token.local=false'), null);
    assert.equal(extractAuthTokenFromCookieString('other=123'), null);
    assert.equal(extractAuthTokenFromCookieString(''), null);
  });

  it('queries active AMIS tab and syncs auth token on mount and tab activation', async () => {
    let activeUrl = 'https://amis.uplb.edu.ph/';
    let cookieResult: string | null = 'Bearer jwt-token-1';
    let activatedListener: ((info: { tabId: number; windowId: number }) => void) | null = null;
    let listenerRemoved = false;

    const mockChrome: ChromeBridgeApi = {
      tabs: {
        async query() {
          return [{ id: 42, url: activeUrl }];
        },
        onActivated: {
          addListener(listener) {
            activatedListener = listener;
          },
          removeListener() {
            listenerRemoved = true;
          },
        },
      },
      scripting: {
        async executeScript<_TArgs extends unknown[], TResult>(): Promise<
          Array<{ result?: TResult }>
        > {
          return [{ result: cookieResult as unknown as TResult }];
        },
      },
    };

    const tab = await getActiveAmisTab(mockChrome);
    assert.deepEqual(tab, { id: 42, url: 'https://amis.uplb.edu.ph/' });

    const observedTokens: Array<string | null> = [];
    const unsubscribe = subscribeAuthTokenSync((t) => observedTokens.push(t), mockChrome);

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(observedTokens, ['Bearer jwt-token-1']);

    activeUrl = 'https://example.com/';
    cookieResult = null;
    activatedListener!({ tabId: 99, windowId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(observedTokens, ['Bearer jwt-token-1', null]);

    unsubscribe();
    assert.equal(listenerRemoved, true);
  });
});

describe('AMIS Read-Only REST Client', () => {
  it('normalizes search queries with + encoding for spaces', () => {
    assert.equal(normalizeCourseSearchQuery('  CMSC   128  '), 'CMSC+128');
    assert.equal(normalizeCourseSearchQuery('ETHICS 1'), 'ETHICS+1');
  });

  it('resolves term_id from nextSchedule first and falls back to activeTerm', async () => {
    const nextExecutor: AmisHttpExecutor = async () => ({
      ok: true,
      status: 200,
      body: { nextSchedule: { term_id: 123 }, activeTerm: { term_id: 122 } },
    });
    assert.equal(await fetchActiveTermId('Bearer tok', nextExecutor), 123);

    const activeExecutor: AmisHttpExecutor = async () => ({
      ok: true,
      status: 200,
      body: { nextSchedule: null, activeTerm: { term_id: 122 } },
    });
    assert.equal(await fetchActiveTermId('Bearer tok', activeExecutor), 122);
  });

  it('disambiguates duplicate course_ids in parallel and selects the one with classes', async () => {
    const requestedPaths: string[] = [];
    const oldCourse: RawAmisCourse = {
      course_id: 10,
      course_code: 'CMSC 128',
      units: '3',
      is_multiple_enrollment: false,
    };
    const activeCourse: RawAmisCourse = {
      course_id: 500,
      course_code: 'CMSC 128',
      units: '3',
      is_multiple_enrollment: false,
    };
    const partialMatch: RawAmisCourse = {
      course_id: 999,
      course_code: 'CMSC 1280',
      units: '3',
      is_multiple_enrollment: false,
    };

    const executor: AmisHttpExecutor = async (path): Promise<AmisHttpResult> => {
      requestedPaths.push(path);
      if (path === '/api/courses?course_code_like=CMSC+128') {
        return { ok: true, status: 200, body: { courses: [partialMatch, oldCourse, activeCourse] } };
      }
      if (path.includes('course_id=10')) {
        return { ok: true, status: 200, body: { classes: [] } };
      }
      if (path.includes('course_id=500')) {
        return { ok: true, status: 200, body: { classes: [makeRawClass()] } };
      }
      return { ok: false, status: 404, body: null };
    };

    const course = await fetchCourseWithClasses('Bearer tok', 123, 'cmsc  128', executor);
    assert.equal(course.id, '500');
    assert.equal(course.code, 'CMSC 128');
    assert.equal(course.sections.length, 1);
    assert.deepEqual(course.requiredComponents, ['LEC', 'LAB']);
    assert.ok(requestedPaths.includes('/api/courses?course_code_like=CMSC+128'));
  });

  it('throws COURSE_NOT_FOUND and NO_CLASSES_FOUND appropriately', async () => {
    const emptySearch: AmisHttpExecutor = async () => ({
      ok: true,
      status: 200,
      body: { courses: [] },
    });
    await assert.rejects(
      () => fetchCourseWithClasses('Bearer tok', 123, 'STAT 1', emptySearch),
      (err: unknown) => isAmisError(err) && err.code === 'COURSE_NOT_FOUND'
    );

    const noClasses: AmisHttpExecutor = async (path) => {
      if (path.startsWith('/api/courses')) {
        return {
          ok: true,
          status: 200,
          body: {
            courses: [
              { course_id: 77, course_code: 'STAT 1', units: 3, is_multiple_enrollment: false },
            ],
          },
        };
      }
      return { ok: true, status: 200, body: { classes: [] } };
    };
    await assert.rejects(
      () => fetchCourseWithClasses('Bearer tok', 123, 'STAT 1', noClasses),
      (err: unknown) => isAmisError(err) && err.code === 'NO_CLASSES_FOUND'
    );
  });

  it('fetches auth user id and splits Enlisted / Sent to SAIS from Bookmarked courses', async () => {
    const executor: AmisHttpExecutor = async (path) => {
      if (path === '/api/auth/user') {
        return { ok: true, status: 200, body: { user: { id: 8812 } } };
      }
      if (path.startsWith('/api/students/enlistments')) {
        return {
          ok: true,
          status: 200,
          body: {
            enlistments: [
              {
                student_enlistment_classes: [
                  {
                    status: 'Enlisted',
                    class: {
                      ...makeRawClass({
                        id: 301,
                        course_id: 600,
                        section: 'U',
                        activity: 'LEC',
                        active_class_size: 40,
                        max_class_size: 40,
                        parent: null,
                      }),
                      course: {
                        course_id: 600,
                        course_code: 'ETHICS 1',
                        units: '3',
                        is_multiple_enrollment: false,
                      },
                    },
                  },
                  {
                    status: 'Sent to SAIS',
                    class: {
                      ...makeRawClass({ id: 302, course_id: 700, section: 'C-1L', parent: null }),
                      course: {
                        course_id: 700,
                        course_code: 'STAT 1',
                        units: '3',
                        is_multiple_enrollment: false,
                      },
                    },
                  },
                  {
                    status: 'Bookmarked',
                    class: {
                      ...makeRawClass({ id: 303, course_id: 800, section: 'B', parent: null }),
                      course: {
                        course_id: 800,
                        course_code: 'PI 10',
                        units: '3',
                        is_multiple_enrollment: false,
                      },
                    },
                  },
                ],
              },
            ],
          },
        };
      }
      return { ok: false, status: 404, body: null };
    };

    const userId = await fetchAuthUserId('Bearer tok', executor);
    assert.equal(userId, '8812');

    const { preEnlistedCourses, bookmarkedCourses } = await fetchStudentEnlistments(
      'Bearer tok',
      123,
      userId,
      executor
    );
    assert.deepEqual(
      preEnlistedCourses.map((c) => c.code),
      ['ETHICS 1', 'STAT 1']
    );
    assert.equal(preEnlistedCourses[0].isPreEnlisted, true);
    assert.equal(preEnlistedCourses[0].sections[0].isPreEnlisted, true);
    assert.deepEqual(
      bookmarkedCourses.map((c) => c.code),
      ['PI 10']
    );
    assert.equal(bookmarkedCourses[0].isPreEnlisted, false);
  });

  it('gracefully handles missing token, expired sessions (401/403), malformed JSON, and network errors', async () => {
    const unusedExecutor: AmisHttpExecutor = async () => ({ ok: true, status: 200, body: {} });
    await assert.rejects(
      () => fetchActiveTermId('', unusedExecutor),
      (err: unknown) => isAmisError(err) && err.code === 'UNAUTHENTICATED'
    );

    const expiredExecutor: AmisHttpExecutor = async () => ({
      ok: false,
      status: 401,
      body: { message: 'Unauthenticated' },
    });
    await assert.rejects(
      () => fetchActiveTermId('Bearer expired', expiredExecutor),
      (err: unknown) => isAmisError(err) && err.code === 'SESSION_EXPIRED' && err.statusCode === 401
    );

    const malformedExecutor: AmisHttpExecutor = async () => ({
      ok: true,
      status: 200,
      body: null,
      parseError: true,
    });
    await assert.rejects(
      () => fetchAuthUserId('Bearer tok', malformedExecutor),
      (err: unknown) => isAmisError(err) && err.code === 'MALFORMED_RESPONSE'
    );

    const networkExecutor: AmisHttpExecutor = async () => ({
      ok: false,
      status: 0,
      body: null,
      networkError: 'Failed to fetch',
    });
    await assert.rejects(
      () => fetchActiveTermId('Bearer tok', networkExecutor),
      (err: unknown) => isAmisError(err) && err.code === 'NETWORK_ERROR'
    );
  });
});
