import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCourseEntryFromRaw,
  checkExhaustedCapacity,
  compareSectionsCanonical,
  deriveRequiredComponents,
  filterAndPruneSections,
  parseClassDates,
  parseRawClass,
  parseRawCourse,
  parseTimeToMinutes,
} from '../src/amis/parser.ts';
import { isAmisError } from '../src/amis/errors.ts';
import type { RawAmisClass, RawAmisCourse } from '../src/types/amis.ts';

function makeRawClass(overrides: Partial<RawAmisClass> = {}): RawAmisClass {
  return {
    id: 1001,
    course_id: 500,
    section: 'AB-1L',
    activity: 'LAB',
    hide_faculty: false,
    faculties: [
      {
        faculty: {
          user: {
            first_name: 'Juan',
            middle_name: 'R.',
            last_name: 'Dela Cruz',
          },
        },
      },
    ],
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
    active_class_size: 14,
    max_class_size: 25,
    is_prerog_open: false,
    parent: null,
    ...overrides,
  };
}

describe('parseTimeToMinutes', () => {
  it('converts 12-hour AM/PM strings accurately including midnight and noon edge cases', () => {
    assert.equal(parseTimeToMinutes('12:00 AM'), 0);
    assert.equal(parseTimeToMinutes('12:30 AM'), 30);
    assert.equal(parseTimeToMinutes('08:00 AM'), 480);
    assert.equal(parseTimeToMinutes('12:00 PM'), 720);
    assert.equal(parseTimeToMinutes('01:00 PM'), 780);
    assert.equal(parseTimeToMinutes('07:00 PM'), 1140);
    assert.equal(parseTimeToMinutes('11:59 PM'), 1439);
  });

  it('tolerates lowercase meridiem and surrounding whitespace', () => {
    assert.equal(parseTimeToMinutes(' 7:15 am '), 435);
    assert.equal(parseTimeToMinutes('4:45pm'), 1005);
  });

  it('returns null for malformed or out-of-range time strings', () => {
    assert.equal(parseTimeToMinutes('25:00 PM'), null);
    assert.equal(parseTimeToMinutes('00:00 AM'), null);
    assert.equal(parseTimeToMinutes('12:60 PM'), null);
    assert.equal(parseTimeToMinutes('TBA'), null);
    assert.equal(parseTimeToMinutes(''), null);
  });
});

describe('parseClassDates', () => {
  it('maps day flags in canonical Monday..Saturday order and omits TBA entries', () => {
    const intervals = parseClassDates([
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
      {
        mon: false,
        tue: false,
        wed: false,
        thu: false,
        fri: false,
        sat: false,
        start_time: '08:00 AM',
        end_time: '09:00 AM',
      },
    ]);

    assert.equal(intervals.length, 1);
    assert.deepEqual(intervals[0], {
      days: ['Tuesday', 'Thursday'],
      startTime: '08:00 AM',
      endTime: '09:00 AM',
      startMinutes: 480,
      endMinutes: 540,
    });
  });

  it('throws MALFORMED_RESPONSE when class_dates is not an array', () => {
    assert.throws(
      () => parseClassDates(null),
      (err: unknown) => isAmisError(err) && err.code === 'MALFORMED_RESPONSE'
    );
  });
});

describe('parseRawCourse & parseRawClass', () => {
  it('parses a raw course into a CourseEntry shell', () => {
    const rawCourse: RawAmisCourse = {
      course_id: 500,
      course_code: 'CMSC 128',
      units: '3.0',
      is_multiple_enrollment: false,
    };

    const entry = parseRawCourse(rawCourse, { instanceId: 'fixed-uuid' });
    assert.equal(entry.id, '500');
    assert.equal(entry.code, 'CMSC 128');
    assert.equal(entry.units, 3);
    assert.equal(entry.canEnrollMultiple, false);
    assert.equal(entry.instanceId, 'fixed-uuid');
    assert.equal(entry.isPreEnlisted, false);
  });

  it('recursively parses parent lecture, respects hide_faculty, and normalizes empty activity', () => {
    const parentLec = makeRawClass({
      id: 900,
      section: 'AB',
      activity: 'LEC',
      hide_faculty: true,
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
      parent: null,
    });

    const childLab = makeRawClass({
      id: 1001,
      section: 'AB-1L',
      activity: 'LAB',
      parent: parentLec,
    });

    const parsedLab = parseRawClass(childLab);
    assert.equal(parsedLab.id, '1001');
    assert.equal(parsedLab.parentClassId, '900');
    assert.ok(parsedLab.parentClass);
    assert.deepEqual(parsedLab.parentClass.faculties, []);
    assert.equal(parsedLab.faculties.length, 1);
    assert.equal(parsedLab.faculties[0].lastName, 'Dela Cruz');

    const standalone = parseRawClass(makeRawClass({ id: 1002, activity: '' }));
    assert.equal(standalone.activity, null);
  });

  it('falls back to parent_class_id when nested parent is null', () => {
    const snapshotSection = parseRawClass(
      makeRawClass({
        id: 1005,
        parent: null,
        parent_class_id: 888,
      })
    );
    assert.equal(snapshotSection.parentClass, null);
    assert.equal(snapshotSection.parentClassId, '888');
  });

  it('rejects circular parent references and malformed payloads with MALFORMED_RESPONSE', () => {
    const circular: RawAmisClass = makeRawClass({ id: 77 });
    circular.parent = circular;

    assert.throws(
      () => parseRawClass(circular),
      (err: unknown) => isAmisError(err) && err.code === 'MALFORMED_RESPONSE'
    );

    assert.throws(
      () => parseRawCourse({ course_id: 1, course_code: 'CMSC 12', units: 'invalid' }),
      (err: unknown) => isAmisError(err) && err.code === 'MALFORMED_RESPONSE'
    );
  });
});

describe('Preprocessing: TBA filtering, capacity pruning, and canonical sorting', () => {
  it('drops TBA sections (including child sections whose parent LEC is TBA)', () => {
    const validLab = parseRawClass(
      makeRawClass({
        id: 1,
        section: 'AB-1L',
        parent: makeRawClass({ id: 10, section: 'AB', activity: 'LEC' }),
      })
    );
    const tbaParentLab = parseRawClass(
      makeRawClass({
        id: 2,
        section: 'AB-2L',
        parent: makeRawClass({ id: 20, section: 'AB', activity: 'LEC', class_dates: [] }),
      })
    );

    const { valid, droppedTba } = filterAndPruneSections([validLab, tbaParentLab], {
      isPreEnlisted: false,
    });
    assert.deepEqual(valid.map((s) => s.id), ['1']);
    assert.deepEqual(droppedTba.map((s) => s.id), ['2']);
  });

  it('prunes full sections for intended courses but exempts pre-enlisted courses', () => {
    const fullSection = parseRawClass(
      makeRawClass({ id: 11, section: 'S-1L', active_class_size: 25, max_class_size: 25 })
    );
    const openSection = parseRawClass(
      makeRawClass({ id: 12, section: 'S-2L', active_class_size: 10, max_class_size: 25 })
    );

    const intended = filterAndPruneSections([fullSection, openSection], { isPreEnlisted: false });
    assert.deepEqual(intended.valid.map((s) => s.id), ['12']);
    assert.deepEqual(intended.droppedFull.map((s) => s.id), ['11']);

    const preEnlisted = filterAndPruneSections([fullSection, openSection], { isPreEnlisted: true });
    assert.deepEqual(preEnlisted.valid.map((s) => s.id), ['11', '12']);
    assert.equal(preEnlisted.droppedFull.length, 0);
  });

  it('detects EXHAUSTED_CAPACITY early when all non-pre-enlisted sections are full or TBA', () => {
    const rawCourse: RawAmisCourse = {
      course_id: 500,
      course_code: 'CMSC 128',
      units: 3,
      is_multiple_enrollment: false,
    };
    const course = buildCourseEntryFromRaw(rawCourse, [
      makeRawClass({ id: 1, section: 'AB-1L', active_class_size: 25, max_class_size: 25 }),
      makeRawClass({ id: 2, section: 'AB-2L', class_dates: [] }),
    ]);

    const result = checkExhaustedCapacity(course);
    assert.equal(result.exhausted, true);
    assert.equal(result.validOptions.length, 0);
  });

  it('sorts sections canonically and derives required components parent-first', () => {
    const lec = parseRawClass(makeRawClass({ id: 1, section: 'AB', activity: 'LEC' }));
    const lab10 = parseRawClass(
      makeRawClass({ id: 2, section: 'AB-10L', activity: 'LAB', parent: makeRawClass({ id: 1, section: 'AB', activity: 'LEC' }) })
    );
    const lab2 = parseRawClass(
      makeRawClass({ id: 3, section: 'AB-2L', activity: 'LAB', parent: makeRawClass({ id: 1, section: 'AB', activity: 'LEC' }) })
    );

    const sorted = [lab10, lec, lab2].sort(compareSectionsCanonical);
    assert.deepEqual(
      sorted.map((s) => `${s.activity}:${s.section}`),
      ['LAB:AB-2L', 'LAB:AB-10L', 'LEC:AB']
    );

    const components = deriveRequiredComponents([lab10]);
    assert.deepEqual(components, ['LEC', 'LAB']);
  });

  it('collapses distinct Special Topics subtitles (CMSC 191) into a single required component while preserving display activity', () => {
    const rawCourse: RawAmisCourse = {
      course_id: 191,
      course_code: 'CMSC 191',
      units: '3.0',
      is_multiple_enrollment: true,
    };

    const course = buildCourseEntryFromRaw(rawCourse, [
      makeRawClass({
        id: 19101,
        course_id: 191,
        section: 'WX',
        activity: 'Introduction to natural language processing',
        class_dates: [
          {
            mon: false,
            tue: true,
            wed: false,
            thu: false,
            fri: false,
            sat: false,
            start_time: '01:00 PM',
            end_time: '04:00 PM',
          },
        ],
      }),
      makeRawClass({
        id: 19102,
        course_id: 191,
        section: 'EF',
        activity: 'Knowledge management systems',
        class_dates: [
          {
            mon: true,
            tue: false,
            wed: false,
            thu: false,
            fri: false,
            sat: false,
            start_time: '01:00 PM',
            end_time: '04:00 PM',
          },
        ],
      }),
    ]);

    assert.deepEqual(course.requiredComponents, ['DEFAULT']);
    assert.deepEqual(
      course.sections.map((opt) => ({
        section: opt.section.section,
        activity: opt.section.activity,
      })),
      [
        { section: 'WX', activity: 'Introduction to natural language processing' },
        { section: 'EF', activity: 'Knowledge management systems' },
      ]
    );
  });
});
