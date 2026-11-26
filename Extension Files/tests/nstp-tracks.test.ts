import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  buildCourseEntryFromRaw,
  classifyNstpSectionTrack,
  compareNstpSections,
  computeNstpTrackCounts,
  getSectionNstpTrack,
  isNstpCourse,
  parseRawClass,
  sortCourseSectionsForDisplay,
} from '../src/amis/parser.ts';
import { exportPlanSnapshot, parsePlanSnapshot } from '../src/amis/snapshot.ts';
import type { RawAmisClass, RawAmisCourse } from '../src/types/amis.ts';
import {
  createDefaultAcademicPlanState,
  type CourseEntry,
  type NstpTrackFilter,
} from '../src/types/domain.ts';
import {
  addSearchedIntendedCourse,
  applyNstpTrackFilter,
  toggleSectionFlag,
} from '../src/ui/planActions.ts';
import { handleWorkerRequest } from '../src/workers/solver.worker.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_ROOT = path.resolve(__dirname, '..');
const TEMP_DIR = path.join(EXT_ROOT, 'node_modules', '.vite-temp');

function makeRawNstpClass(overrides: Partial<RawAmisClass> = {}): RawAmisClass {
  return {
    id: 2001,
    course_id: 202,
    section: 'A',
    activity: '',
    hide_faculty: true,
    faculties: [],
    facility_id: 'CAS A1',
    class_dates: [
      {
        mon: false,
        tue: false,
        wed: false,
        thu: false,
        fri: false,
        sat: true,
        start_time: '08:00 AM',
        end_time: '11:00 AM',
      },
    ],
    active_class_size: 10,
    max_class_size: 35,
    is_prerog_open: false,
    parent: null,
    ...overrides,
  };
}

function makeMixedNstp2Course(): CourseEntry {
  const rawCourse: RawAmisCourse = {
    course_id: 202,
    course_code: 'NSTP 2',
    units: '3.0',
    is_multiple_enrollment: false,
    course_title: 'National Service Training Program 2',
  };

  return buildCourseEntryFromRaw(
    rawCourse,
    [
      // Unlabeled general section (neither CWTS nor LTS)
      makeRawNstpClass({
        id: 2010,
        section: 'Z-2',
        activity: '',
        notes: 'General NSTP section pending track assignment',
      }),
      // LTS via full name in activity
      makeRawNstpClass({
        id: 2008,
        section: 'B-10',
        activity: 'Literacy Training Service',
        class_dates: [
          {
            mon: false,
            tue: false,
            wed: false,
            thu: false,
            fri: false,
            sat: true,
            start_time: '01:00 PM',
            end_time: '04:00 PM',
          },
        ],
      }),
      // CWTS via section naming convention
      makeRawNstpClass({
        id: 2003,
        section: 'CWTS-10',
        activity: '',
      }),
      // Unlabeled section
      makeRawNstpClass({
        id: 2009,
        section: 'A-1',
        activity: 'LEC',
      }),
      // LTS via notes metadata
      makeRawNstpClass({
        id: 2006,
        section: 'B-2',
        activity: '',
        notes: 'Track: LTS - Community literacy deployment',
        class_dates: [
          {
            mon: false,
            tue: false,
            wed: false,
            thu: false,
            fri: false,
            sat: true,
            start_time: '01:00 PM',
            end_time: '04:00 PM',
          },
        ],
      }),
      // CWTS via Civic Welfare Training Service in subtitle
      makeRawNstpClass({
        id: 2002,
        section: 'CWTS-2',
        activity: '',
        subtitle: 'Civic Welfare Training Service',
      }),
      // CWTS via section_title
      makeRawNstpClass({
        id: 2001,
        section: 'CWTS-1',
        activity: '',
        section_title: 'CWTS Component',
      }),
      // LTS via section naming convention
      makeRawNstpClass({
        id: 2007,
        section: 'LTS-1',
        activity: '',
        class_dates: [
          {
            mon: false,
            tue: false,
            wed: false,
            thu: false,
            fri: false,
            sat: true,
            start_time: '01:00 PM',
            end_time: '04:00 PM',
          },
        ],
      }),
      // ROTC via Reserve Officers' Training Corps subtitle
      makeRawNstpClass({
        id: 2011,
        section: 'R-2',
        activity: '',
        subtitle: "Reserve Officers' Training Corps",
        class_dates: [
          {
            mon: false,
            tue: false,
            wed: false,
            thu: false,
            fri: false,
            sat: true,
            start_time: '07:00 AM',
            end_time: '12:00 PM',
          },
        ],
      }),
      // ROTC via section naming convention
      makeRawNstpClass({
        id: 2012,
        section: 'ROTC-1',
        activity: '',
        class_dates: [
          {
            mon: false,
            tue: false,
            wed: false,
            thu: false,
            fri: false,
            sat: true,
            start_time: '07:00 AM',
            end_time: '12:00 PM',
          },
        ],
      }),
    ],
    { instanceId: 'nstp2-inst', termId: 1262 }
  );
}

describe('NSTP Component Track Classification, Sorting & Filtering', () => {
  let compiledCoursesTabUrl: string | null = null;

  after(() => {
    if (compiledCoursesTabUrl) {
      const filePath = fileURLToPath(compiledCoursesTabUrl);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  async function loadCoursesTabComponent(): Promise<React.ComponentType<Record<string, unknown>>> {
    if (!compiledCoursesTabUrl) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
      const outFile = path.join(TEMP_DIR, `courses-tab-${process.pid}.mjs`);
      await esbuild.build({
        entryPoints: [path.join(EXT_ROOT, 'src/components/CoursesTab.tsx')],
        outfile: outFile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        jsx: 'automatic',
        external: ['react', 'react-dom'],
      });
      compiledCoursesTabUrl = pathToFileURL(outFile).href;
    }
    const mod = (await import(compiledCoursesTabUrl)) as {
      CoursesTab: React.ComponentType<Record<string, unknown>>;
    };
    return mod.CoursesTab;
  }

  it('recognizes NSTP course codes and classifies CWTS, LTS, and Unlabeled sections from metadata', () => {
    assert.equal(isNstpCourse('NSTP 2'), true);
    assert.equal(isNstpCourse('  nstp  1 '), true);
    assert.equal(isNstpCourse('NSTP2'), true);
    assert.equal(isNstpCourse('NSTP-2'), true);
    assert.equal(isNstpCourse('CMSC 128'), false);
    assert.equal(isNstpCourse('STAT 1'), false);

    assert.equal(
      classifyNstpSectionTrack({ activity: 'CWTS', section: 'A' }),
      'CWTS'
    );
    assert.equal(
      classifyNstpSectionTrack({ subtitle: 'Civic Welfare Training Service', section: 'B1' }),
      'CWTS'
    );
    assert.equal(
      classifyNstpSectionTrack({ notes: 'Assigned to CWTS community outreach', section: 'C1' }),
      'CWTS'
    );
    assert.equal(
      classifyNstpSectionTrack({ section: 'NSTP2-CWTS-4', activity: '' }),
      'CWTS'
    );

    assert.equal(
      classifyNstpSectionTrack({ activity: 'LTS', section: 'D1' }),
      'LTS'
    );
    assert.equal(
      classifyNstpSectionTrack({ sectionTitle: 'Literacy Training Service', section: 'E1' }),
      'LTS'
    );
    assert.equal(
      classifyNstpSectionTrack({ notes: 'LTS section for elementary tutoring', section: 'F1' }),
      'LTS'
    );
    assert.equal(
      classifyNstpSectionTrack({ section: 'LTS-3B', activity: '' }),
      'LTS'
    );

    assert.equal(
      classifyNstpSectionTrack({ activity: 'ROTC', section: 'M1' }),
      'ROTC'
    );
    assert.equal(
      classifyNstpSectionTrack({
        subtitle: "Reserve Officers' Training Corps",
        section: 'M2',
      }),
      'ROTC'
    );
    assert.equal(
      classifyNstpSectionTrack({ notes: 'MS / ROTC Cadet training', section: 'M3' }),
      'ROTC'
    );
    assert.equal(
      classifyNstpSectionTrack({ section: 'NSTP2-ROTC-1', activity: '' }),
      'ROTC'
    );

    // Ensure common English words ending in "lts" (e.g., "results", "adults") do not falsely trigger LTS
    assert.equal(
      classifyNstpSectionTrack({
        section: 'G1',
        activity: 'LEC',
        notes: 'Results for young adults program',
      }),
      'Unlabeled'
    );

    // Parent class metadata inheritance when child section has no explicit track label
    const parentCwts = parseRawClass(
      makeRawNstpClass({ id: 901, section: 'CWTS-LEC', activity: 'CWTS' }),
      new Set(),
      { courseCode: 'NSTP 2' }
    );
    const childLab = parseRawClass(
      makeRawNstpClass({ id: 902, section: 'A-1L', activity: 'LAB', parent: null }),
      new Set(),
      { courseCode: 'NSTP 2' }
    );
    childLab.parentClass = parentCwts;
    assert.equal(
      classifyNstpSectionTrack({
        section: childLab.section,
        activity: childLab.activity,
        parentSection: childLab.parentClass,
      }),
      'CWTS'
    );
  });

  it('sorts NSTP sections deterministically by track (CWTS -> LTS -> ROTC -> Unlabeled) and alphabetically/naturally within each track', () => {
    const nstp2 = makeMixedNstp2Course();

    assert.deepEqual(
      nstp2.sections.map((opt) => ({
        section: opt.section.section,
        track: getSectionNstpTrack(opt.section, nstp2.code),
      })),
      [
        { section: 'CWTS-1', track: 'CWTS' },
        { section: 'CWTS-2', track: 'CWTS' },
        { section: 'CWTS-10', track: 'CWTS' },
        { section: 'B-2', track: 'LTS' },
        { section: 'B-10', track: 'LTS' },
        { section: 'LTS-1', track: 'LTS' },
        { section: 'R-2', track: 'ROTC' },
        { section: 'ROTC-1', track: 'ROTC' },
        { section: 'A-1', track: 'Unlabeled' },
        { section: 'Z-2', track: 'Unlabeled' },
      ]
    );

    assert.deepEqual(computeNstpTrackCounts(nstp2.sections, nstp2.code), {
      All: 10,
      CWTS: 3,
      LTS: 3,
      ROTC: 2,
      Unlabeled: 2,
    });

    // Legacy unsorted NSTP CourseEntry without precomputed .track field still sorts cleanly
    const legacyUnsorted = {
      ...nstp2,
      sections: [...nstp2.sections]
        .reverse()
        .map((opt) => ({
          ...opt,
          section: { ...opt.section, track: undefined },
        })),
    };
    const resorted = sortCourseSectionsForDisplay(legacyUnsorted.sections, legacyUnsorted.code);
    assert.deepEqual(
      resorted.map((opt) => opt.section.section),
      ['CWTS-1', 'CWTS-2', 'CWTS-10', 'B-2', 'B-10', 'LTS-1', 'R-2', 'ROTC-1', 'A-1', 'Z-2']
    );

    // Direct comparator tie-breaking
    assert.ok(compareNstpSections(nstp2.sections[0].section, nstp2.sections[3].section) < 0);
    assert.ok(compareNstpSections(nstp2.sections[3].section, nstp2.sections[6].section) < 0);
    assert.ok(compareNstpSections(nstp2.sections[6].section, nstp2.sections[8].section) < 0);
  });

  it('filters and auto-hides other tracks on track selection, unhides on All, and steers the CP-SAT solver', async () => {
    const nstp2 = makeMixedNstp2Course();
    let plan = createDefaultAcademicPlanState();
    plan.termId = 1262;
    plan.intendedCourses = [nstp2];

    // Lock an LTS section first to verify auto-hide clears incompatible locks on hidden tracks
    plan = toggleSectionFlag(plan, nstp2.instanceId, '2007', 'isLocked');
    plan = toggleSectionFlag(plan, nstp2.instanceId, '2001', 'isStarred');

    // Select CWTS track -> filters to CWTS and hides LTS + Unlabeled
    plan = applyNstpTrackFilter(plan, nstp2.instanceId, 'CWTS');
    const afterCwts = plan.intendedCourses[0];
    assert.equal(afterCwts.nstpTrackFilter, 'CWTS');

    for (const opt of afterCwts.sections) {
      const track = getSectionNstpTrack(opt.section, afterCwts.code);
      if (track === 'CWTS') {
        assert.equal(opt.flags.isHidden, false);
      } else {
        assert.equal(opt.flags.isHidden, true);
        assert.equal(opt.flags.isLocked, false);
      }
    }
    // Starred flag on CWTS-1 is preserved
    assert.equal(
      afterCwts.sections.find((opt) => opt.section.id === '2001')?.flags.isStarred,
      true
    );

    // Solve with CP-SAT: must select a CWTS section (never LTS or Unlabeled)
    const cwtsSolve = await handleWorkerRequest({
      type: 'SOLVE_SCHEDULE',
      requestId: 'nstp-cwts-solve',
      plan,
    });
    assert.ok(cwtsSolve && cwtsSolve.type === 'SOLVE_SCHEDULE_RESULT' && cwtsSolve.ok);
    assert.equal(cwtsSolve.payload?.status, 'OPTIMAL');
    for (const alt of cwtsSolve.payload?.alternatives ?? []) {
      const chosenIds = alt.selectedSectionIds;
      assert.equal(chosenIds.length, 1);
      const chosenOption = afterCwts.sections.find((opt) => opt.section.id === chosenIds[0]);
      assert.ok(chosenOption);
      assert.equal(getSectionNstpTrack(chosenOption.section, afterCwts.code), 'CWTS');
    }

    // Switch to LTS track -> unhides LTS sections and hides CWTS + Unlabeled
    plan = applyNstpTrackFilter(plan, nstp2.instanceId, 'LTS');
    const afterLts = plan.intendedCourses[0];
    assert.equal(afterLts.nstpTrackFilter, 'LTS');
    for (const opt of afterLts.sections) {
      const track = getSectionNstpTrack(opt.section, afterLts.code);
      assert.equal(opt.flags.isHidden, track !== 'LTS');
    }

    const ltsSolve = await handleWorkerRequest({
      type: 'SOLVE_SCHEDULE',
      requestId: 'nstp-lts-solve',
      plan,
    });
    assert.ok(ltsSolve && ltsSolve.type === 'SOLVE_SCHEDULE_RESULT' && ltsSolve.ok);
    assert.equal(ltsSolve.payload?.status, 'OPTIMAL');
    const ltsChosenId = ltsSolve.payload?.alternatives[0]?.selectedSectionIds[0];
    const ltsChosenOpt = afterLts.sections.find((opt) => opt.section.id === ltsChosenId);
    assert.ok(ltsChosenOpt);
    assert.equal(getSectionNstpTrack(ltsChosenOpt.section, afterLts.code), 'LTS');

    // Switch to ROTC track -> unhides ROTC sections and hides CWTS, LTS, and Unlabeled
    plan = applyNstpTrackFilter(plan, nstp2.instanceId, 'ROTC');
    const afterRotc = plan.intendedCourses[0];
    assert.equal(afterRotc.nstpTrackFilter, 'ROTC');
    for (const opt of afterRotc.sections) {
      const track = getSectionNstpTrack(opt.section, afterRotc.code);
      assert.equal(opt.flags.isHidden, track !== 'ROTC');
    }

    const rotcSolve = await handleWorkerRequest({
      type: 'SOLVE_SCHEDULE',
      requestId: 'nstp-rotc-solve',
      plan,
    });
    assert.ok(rotcSolve && rotcSolve.type === 'SOLVE_SCHEDULE_RESULT' && rotcSolve.ok);
    assert.equal(rotcSolve.payload?.status, 'OPTIMAL');
    const rotcChosenId = rotcSolve.payload?.alternatives[0]?.selectedSectionIds[0];
    const rotcChosenOpt = afterRotc.sections.find((opt) => opt.section.id === rotcChosenId);
    assert.ok(rotcChosenOpt);
    assert.equal(getSectionNstpTrack(rotcChosenOpt.section, afterRotc.code), 'ROTC');

    // Clicking All unhides all tracks
    plan = applyNstpTrackFilter(plan, nstp2.instanceId, 'All');
    const afterAll = plan.intendedCourses[0];
    assert.equal(afterAll.nstpTrackFilter, 'All');
    assert.equal(
      afterAll.sections.every((opt) => opt.flags.isHidden === false),
      true
    );

    // Snapshot round-trip preserves track, subtitle, notes, and nstpTrackFilter
    plan = applyNstpTrackFilter(plan, nstp2.instanceId, 'Unlabeled');
    const roundTripped = parsePlanSnapshot(exportPlanSnapshot(plan));
    assert.equal(roundTripped.plan.intendedCourses[0].nstpTrackFilter, 'Unlabeled');
    assert.equal(roundTripped.plan.intendedCourses[0].sections[0].section.track, 'CWTS');

    // Re-searching NSTP 2 unhides all sections and resets nstpTrackFilter
    const researched = addSearchedIntendedCourse(plan, makeMixedNstp2Course());
    assert.equal(researched.outcome, 'updated_existing');
    assert.equal(researched.plan.intendedCourses[0].nstpTrackFilter, undefined);
    assert.equal(
      researched.plan.intendedCourses[0].sections.every((opt) => opt.flags.isHidden === false),
      true
    );
  });

  it('renders track filter pills with counts, track badges, and filtered section rows in CoursesTab', async () => {
    const CoursesTab = await loadCoursesTabComponent();
    const nstp2 = makeMixedNstp2Course();

    const commonProps = {
      preEnlistedCourses: [],
      selectedTermId: 1262,
      availableTerms: [
        {
          termId: 1262,
          label: '1262 - 2nd Sem (2026-2027)',
          shortLabel: '2nd Sem (2026-2027)',
          isMidyear: false,
          source: 'fallback',
        },
      ],
      emptyTermSuggestion: null,
      authStatus: 'connected',
      isOffline: false,
      statusMessage: null,
      searchError: null,
      isSyncing: false,
      isAddingCourse: false,
      isSolving: false,
      isSolveBlocked: false,
      canGenerate: true,
      onSelectTerm: () => undefined,
      onSyncAmis: () => undefined,
      onSearchSuggestions: async () => [],
      onAddCourseByCode: async () => true,
      onRemoveCourse: () => undefined,
      onToggleAccordion: () => undefined,
      onToggleSectionFlag: () => undefined,
      onSelectNstpTrackFilter: (_id: string, _track: NstpTrackFilter) => undefined,
      onGenerateSchedules: () => undefined,
      onCancelSolve: () => undefined,
    };

    const htmlAll = renderToStaticMarkup(
      React.createElement(CoursesTab, {
        ...commonProps,
        intendedCourses: [nstp2],
      })
    );

    assert.ok(htmlAll.includes('All (10)'));
    assert.ok(htmlAll.includes('CWTS (3)'));
    assert.ok(htmlAll.includes('LTS (3)'));
    assert.ok(htmlAll.includes('ROTC (2)'));
    assert.ok(htmlAll.includes('Unlabeled (2)'));
    assert.ok(htmlAll.includes('section-track-badge--cwts'));
    assert.ok(htmlAll.includes('section-track-badge--lts'));
    assert.ok(htmlAll.includes('section-track-badge--rotc'));
    assert.ok(htmlAll.includes('section-track-badge--unlabeled'));
    assert.ok(htmlAll.includes('SEC CWTS-1'));
    assert.ok(htmlAll.includes('SEC LTS-1'));
    assert.ok(htmlAll.includes('SEC ROTC-1'));
    assert.ok(htmlAll.includes('SEC Z-2'));

    // Verify deterministic track order in rendered DOM: CWTS-1 -> LTS-1 -> ROTC-1 -> Z-2
    assert.ok(htmlAll.indexOf('SEC CWTS-1') < htmlAll.indexOf('SEC LTS-1'));
    assert.ok(htmlAll.indexOf('SEC LTS-1') < htmlAll.indexOf('SEC ROTC-1'));
    assert.ok(htmlAll.indexOf('SEC ROTC-1') < htmlAll.indexOf('SEC Z-2'));

    // Filtered to CWTS: only CWTS sections rendered, LTS/ROTC/Unlabeled omitted
    const planCwts = applyNstpTrackFilter(
      {
        ...createDefaultAcademicPlanState(),
        termId: 1262,
        intendedCourses: [nstp2],
      },
      nstp2.instanceId,
      'CWTS'
    );
    const htmlCwts = renderToStaticMarkup(
      React.createElement(CoursesTab, {
        ...commonProps,
        intendedCourses: planCwts.intendedCourses,
      })
    );

    assert.ok(htmlCwts.includes('SEC CWTS-1'));
    assert.ok(htmlCwts.includes('SEC CWTS-2'));
    assert.ok(htmlCwts.includes('SEC CWTS-10'));
    assert.equal(htmlCwts.includes('SEC LTS-1'), false);
    assert.equal(htmlCwts.includes('SEC ROTC-1'), false);
    assert.equal(htmlCwts.includes('SEC Z-2'), false);
    assert.ok(htmlCwts.includes('Only CWTS active in solver (7 hidden)'));
    assert.ok(htmlCwts.includes('Show All'));

    // Non-NSTP course does NOT render NSTP filter pills or track badges
    const nonNstp = buildCourseEntryFromRaw(
      {
        course_id: 128,
        course_code: 'CMSC 128',
        units: '3',
        is_multiple_enrollment: false,
      },
      [makeRawNstpClass({ id: 5001, course_id: 128, section: 'AB', activity: 'LEC' })],
      { instanceId: 'cmsc-128-inst', termId: 1262 }
    );
    const htmlNonNstp = renderToStaticMarkup(
      React.createElement(CoursesTab, {
        ...commonProps,
        intendedCourses: [nonNstp],
      })
    );
    assert.equal(htmlNonNstp.includes('nstp-track-filter-bar'), false);
    assert.equal(htmlNonNstp.includes('section-track-badge'), false);
  });
});
