import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { solveAcademicPlan } from '../src/solver/engine.ts';
import {
  COMPARE_HANDOFF_STORAGE_KEY,
  consumeCompareHandoff,
  saveCompareHandoff,
  type StorageAreaLike,
} from '../src/storage/planStorage.ts';
import {
  createDefaultAcademicPlanState,
  type AcademicPlanState,
  type CourseEntry,
  type Weekday,
} from '../src/types/domain.ts';
import type { GeneratedScheduleAlternative } from '../src/types/solver.ts';
import {
  applyGeneratedAlternatives,
  buildPlanComparisonCards,
  closeComparisonModal,
  createInitialPlanComparisonState,
  formatCompactTimeRange,
  formatComparisonHeaderBadge,
  formatIdleGapHours,
  getEscapeKeyAction,
  openComparisonModal,
  selectPlanFromComparison,
} from '../src/ui/planComparison.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_ROOT = path.resolve(__dirname, '..');
const TEMP_DIR = path.join(EXT_ROOT, 'node_modules', '.vite-temp');

const tempFilesToClean: string[] = [];

async function loadTsxComponent<TModule>(relativeSrcPath: string): Promise<TModule> {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const outfile = path.join(
    TEMP_DIR,
    `test-compare-${path.basename(relativeSrcPath, '.tsx')}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.mjs`
  );
  tempFilesToClean.push(outfile);

  await esbuild.build({
    entryPoints: [path.join(EXT_ROOT, relativeSrcPath)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    jsx: 'automatic',
  });

  return (await import(pathToFileURL(outfile).href)) as TModule;
}

after(() => {
  for (const file of tempFilesToClean) {
    fs.rmSync(file, { force: true });
  }
});

function createMemoryStorage(): {
  storage: StorageAreaLike;
  raw: Map<string, unknown>;
} {
  const raw = new Map<string, unknown>();
  const storage: StorageAreaLike = {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) {
        if (raw.has(k)) {
          out[k] = structuredClone(raw.get(k));
        }
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        raw.set(k, structuredClone(v));
      }
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        raw.delete(k);
      }
    },
  };
  return { storage, raw };
}

function makeCourse(
  id: string,
  code: string,
  units: number,
  sections: Array<{
    id: string;
    section: string;
    days: Weekday[];
    startMinutes: number;
    endMinutes: number;
    isStarred?: boolean;
    isPreEnlisted?: boolean;
    location?: string;
  }>,
  isPreEnlisted = false
): CourseEntry {
  return {
    instanceId: `inst-${id}`,
    id,
    code,
    units,
    canEnrollMultiple: false,
    isPreEnlisted,
    requiredComponents: ['LEC'],
    isExpanded: true,
    sections: sections.map((s) => ({
      isPreEnlisted: Boolean(s.isPreEnlisted ?? isPreEnlisted),
      flags: {
        isHidden: false,
        isLocked: false,
        isStarred: Boolean(s.isStarred),
      },
      section: {
        id: s.id,
        courseId: id,
        section: s.section,
        activity: 'LEC',
        faculties: [{ firstName: 'Jane', middleName: '', lastName: 'Doe' }],
        location: s.location ?? 'ICS LH1',
        dates: [
          {
            days: s.days,
            startTime: `${s.startMinutes}`,
            endTime: `${s.endMinutes}`,
            startMinutes: s.startMinutes,
            endMinutes: s.endMinutes,
          },
        ],
        activeClassSize: 10,
        maxClassSize: 30,
        isPrerogOpen: false,
        parentClassId: null,
        parentClass: null,
      },
    })),
  };
}

function makeSamplePlanWithAlternatives(): {
  plan: AcademicPlanState;
  alternatives: GeneratedScheduleAlternative[];
} {
  const plan = createDefaultAcademicPlanState();
  plan.preEnlistedCourses = [
    makeCourse(
      '165',
      'CMSC 165',
      3,
      [
        {
          id: '165-S',
          section: 'S',
          days: ['Tuesday', 'Thursday'],
          startMinutes: 420, // 7:00 AM - 8:00 AM
          endMinutes: 480,
          isPreEnlisted: true,
          location: 'SMA LH',
        },
      ],
      true
    ),
  ];

  plan.intendedCourses = [
    makeCourse('128', 'CMSC 128', 3, [
      {
        id: '128-A',
        section: 'AB-1L',
        days: ['Tuesday', 'Thursday'],
        startMinutes: 480, // 8:00 AM - 9:30 AM (0 min gap after 165-S)
        endMinutes: 570,
        isStarred: true,
      },
      {
        id: '128-B',
        section: 'CD-2L',
        days: ['Tuesday', 'Thursday'],
        startMinutes: 600, // 10:00 AM - 11:30 AM (2 hr gap on Tue & Thu = 4 hrs total)
        endMinutes: 690,
        isStarred: false,
      },
      {
        id: '128-C',
        section: 'EF-3L',
        days: ['Monday', 'Wednesday'],
        startMinutes: 540, // 9:00 AM - 10:30 AM (0 gap, adds Mon/Wed)
        endMinutes: 630,
        isStarred: false,
      },
    ]),
    makeCourse('1', 'STAT 1', 3, [
      {
        id: '1-X',
        section: 'X-1',
        days: ['Tuesday'],
        startMinutes: 660, // 11:00 AM - 12:30 PM (1.5 hr gap after 128-A on Tue)
        endMinutes: 750,
        isStarred: true,
      },
      {
        id: '1-Y',
        section: 'Y-2',
        days: ['Friday'],
        startMinutes: 780, // 1:00 PM - 2:30 PM
        endMinutes: 870,
        isStarred: false,
      },
    ]),
  ];

  const alternatives: GeneratedScheduleAlternative[] = [
    {
      planLabel: 'Plan A',
      profileTag: 'Balanced',
      totalUnits: 9,
      status: 'OPTIMAL',
      objectiveScoreZ: 45,
      selectedSectionIds: ['165-S', '128-A', '1-X'],
      hammingDistanceFromPrev: [],
    },
    {
      planLabel: 'Plan B',
      profileTag: 'Compact Days',
      totalUnits: 9,
      status: 'OPTIMAL',
      objectiveScoreZ: 120,
      selectedSectionIds: ['165-S', '128-B', '1-Y'],
      hammingDistanceFromPrev: [4],
    },
    {
      planLabel: 'Plan C',
      profileTag: 'Later Start',
      totalUnits: 9,
      status: 'FEASIBLE',
      objectiveScoreZ: 190,
      selectedSectionIds: ['165-S', '128-C', '1-X'],
      hammingDistanceFromPrev: [4, 4],
    },
  ];

  return { plan, alternatives };
}

function findElements(
  node: React.ReactNode,
  predicate: (el: React.ReactElement<Record<string, unknown>>) => boolean,
  out: Array<React.ReactElement<Record<string, unknown>>> = []
): Array<React.ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) {
    for (const child of node) {
      findElements(child, predicate, out);
    }
    return out;
  }
  if (!React.isValidElement(node)) {
    return out;
  }
  const el = node as React.ReactElement<Record<string, unknown>>;
  if (predicate(el)) {
    out.push(el);
  }
  if (el.props && 'children' in el.props) {
    findElements(el.props.children as React.ReactNode, predicate, out);
  }
  return out;
}

describe('Side-by-Side Plan Comparison Modal: State, Metrics & Components', () => {
  it('auto-opens when >= 2 feasible plans are generated, skips modal on 1 plan, selects plan, and reopens via Compare', () => {
    const { alternatives } = makeSamplePlanWithAlternatives();

    // 1. Only 1 feasible plan -> applies directly without opening modal
    const singlePlanState = applyGeneratedAlternatives([alternatives[0]]);
    assert.equal(singlePlanState.alternatives.length, 1);
    assert.equal(singlePlanState.selectedPlanIndex, 0);
    assert.equal(singlePlanState.isCompareModalOpen, false);

    // Attempting to open comparison with < 2 plans is a no-op
    assert.equal(openComparisonModal(singlePlanState).isCompareModalOpen, false);

    // 2. 2 or more feasible plans -> automatically opens Compare Generated Plans modal
    const multiPlanState = applyGeneratedAlternatives(alternatives);
    assert.equal(multiPlanState.alternatives.length, 3);
    assert.equal(multiPlanState.selectedPlanIndex, 0);
    assert.equal(multiPlanState.isCompareModalOpen, true);

    // 3. Selecting Plan B sets it active, closes modal, and keeps all generated plans intact
    const afterSelectB = selectPlanFromComparison(multiPlanState, 1);
    assert.equal(afterSelectB.selectedPlanIndex, 1);
    assert.equal(afterSelectB.isCompareModalOpen, false);
    assert.equal(afterSelectB.alternatives.length, 3);

    // 4. Reopening via Compare button preserves the active plan (Plan B)
    const reopened = openComparisonModal(afterSelectB);
    assert.equal(reopened.isCompareModalOpen, true);
    assert.equal(reopened.selectedPlanIndex, 1);
    assert.equal(reopened.alternatives.length, 3);

    // 5. Dismissal (Esc / backdrop / close button) closes modal without discarding plans
    assert.equal(getEscapeKeyAction(reopened.isCompareModalOpen), 'close_compare_modal');
    const dismissed = closeComparisonModal(reopened);
    assert.equal(dismissed.isCompareModalOpen, false);
    assert.equal(dismissed.selectedPlanIndex, 1);
    assert.equal(dismissed.alternatives.length, 3);
    assert.equal(getEscapeKeyAction(dismissed.isCompareModalOpen), 'dismiss_optimizer');

    // Initial state starts closed with empty alternatives
    const initial = createInitialPlanComparisonState();
    assert.equal(initial.alternatives.length, 0);
    assert.equal(initial.isCompareModalOpen, false);
  });

  it('computes accurate idle gaps, earliest/latest class times, starred satisfaction, and chosen sections per plan', () => {
    const { plan, alternatives } = makeSamplePlanWithAlternatives();
    const cards = buildPlanComparisonCards(plan, alternatives);

    assert.equal(cards.length, 3);

    // Plan A: Tue 7-8, 8-9:30, 11-12:30 (90 min gap on Tue); Thu 7-8, 8-9:30 (0 gap) -> 1.5 hrs idle
    assert.equal(cards[0].headerBadge, 'Plan A • Recommended / Optimal');
    assert.equal(cards[0].totalUnitsLabel, '9 Units');
    assert.equal(cards[0].metrics.totalIdleGapMinutes, 90);
    assert.equal(cards[0].metrics.totalIdleGapLabel, '1.5 hrs');
    assert.equal(cards[0].metrics.timeRangeLabel, '7:00 AM – 12:30 PM');
    assert.equal(cards[0].metrics.starredSatisfiedCount, 2);
    assert.equal(cards[0].metrics.starredTargetsCount, 2);
    assert.equal(cards[0].metrics.starredLabel, '2/2 starred');
    assert.deepEqual(
      cards[0].courseSelections.map((c) => `${c.courseCode}:${c.sectionBadge}:${c.scheduleSummary}`),
      [
        'CMSC 165:SEC S:TTh 7:00–8:00 AM',
        'CMSC 128:SEC AB-1L:TTh 8:00–9:30 AM',
        'STAT 1:SEC X-1:T 11:00 AM–12:30 PM',
      ]
    );

    // Plan B: Tue 7-8 & 10-11:30 (2 hr gap); Thu 7-8 & 10-11:30 (2 hr gap); Fri 1-2:30 -> 4 hrs idle, 0/2 starred
    assert.equal(cards[1].headerBadge, 'Plan B');
    assert.equal(cards[1].metrics.totalIdleGapMinutes, 240);
    assert.equal(cards[1].metrics.totalIdleGapLabel, '4 hrs');
    assert.equal(cards[1].metrics.timeRangeLabel, '7:00 AM – 2:30 PM');
    assert.equal(cards[1].metrics.starredLabel, '0/2 starred');
    assert.deepEqual(
      cards[1].courseSelections.map((c) => `${c.courseCode}:${c.sectionBadge}:${c.scheduleSummary}`),
      [
        'CMSC 165:SEC S:TTh 7:00–8:00 AM',
        'CMSC 128:SEC CD-2L:TTh 10:00–11:30 AM',
        'STAT 1:SEC Y-2:F 1:00–2:30 PM',
      ]
    );

    // Plan C: Mon/Wed 9-10:30, Tue 7-8 & 11-12:30 (3 hr gap on Tue), Thu 7-8 -> 3 hrs idle, 1/2 starred
    assert.equal(cards[2].headerBadge, 'Plan C');
    assert.equal(cards[2].statusLabel, 'Feasible');
    assert.equal(cards[2].metrics.totalIdleGapMinutes, 180);
    assert.equal(cards[2].metrics.totalIdleGapLabel, '3 hrs');
    assert.equal(cards[2].metrics.starredLabel, '1/2 starred');
    assert.equal(formatIdleGapHours(0), '0 hrs');
    assert.equal(formatIdleGapHours(60), '1 hr');
    assert.equal(formatCompactTimeRange(780, 960), '1:00–4:00 PM');
    assert.equal(formatCompactTimeRange(690, 780), '11:30 AM–1:00 PM');
    assert.equal(
      formatComparisonHeaderBadge({ ...alternatives[0], status: 'FEASIBLE' }, 0),
      'Plan A • Recommended / Feasible'
    );
  });

  it('integrates with real CP-SAT multi-alternative generation and auto-opens comparison when >= 2 plans are solved', async () => {
    const { plan } = makeSamplePlanWithAlternatives();
    const result = await solveAcademicPlan(plan, { randomSeed: 42 });

    assert.ok(result.status === 'OPTIMAL' || result.status === 'FEASIBLE');
    assert.ok(result.alternatives.length >= 2, 'Expected CP-SAT solver to generate >= 2 distinct plans');

    const compState = applyGeneratedAlternatives(result.alternatives);
    assert.equal(compState.isCompareModalOpen, true);
    assert.equal(compState.selectedPlanIndex, 0);

    const cards = buildPlanComparisonCards(plan, compState.alternatives);
    assert.ok(cards.length >= 2 && cards.length <= 3);
    assert.ok(cards[0].blocks.length > 0);
  });

  it('renders PlanBar Compare (N) button only for 2+ plans while keeping PLAN dropdown and reopening callback', async () => {
    const { alternatives } = makeSamplePlanWithAlternatives();
    const { PlanBar } = await loadTsxComponent<{
      PlanBar: (props: {
        alternatives: readonly GeneratedScheduleAlternative[];
        selectedPlanIndex: number;
        fallbackTotalUnits: number;
        isInfeasible: boolean;
        onSelectPlan: (idx: number) => void;
        onOpenCompare?: () => void;
      }) => React.ReactElement;
    }>('src/components/PlanBar.tsx');

    // 1 plan -> no Compare button
    const singleHtml = renderToStaticMarkup(
      React.createElement(PlanBar, {
        alternatives: [alternatives[0]],
        selectedPlanIndex: 0,
        fallbackTotalUnits: 9,
        isInfeasible: false,
        onSelectPlan: () => undefined,
      })
    );
    assert.ok(singleHtml.includes('id="amisync-plan-select"'));
    assert.ok(!singleHtml.includes('Compare ('));

    // 2 plans -> Compare (2) button next to PLAN dropdown
    const twoHtml = renderToStaticMarkup(
      React.createElement(PlanBar, {
        alternatives: alternatives.slice(0, 2),
        selectedPlanIndex: 0,
        fallbackTotalUnits: 9,
        isInfeasible: false,
        onSelectPlan: () => undefined,
      })
    );
    assert.ok(twoHtml.includes('id="amisync-plan-select"'));
    assert.ok(twoHtml.includes('Compare (2)'));

    // 3 plans -> Compare (3) button invokes onOpenCompare when clicked
    let openCompareCalls = 0;
    let selectedFromDropdown = -1;
    const tree = PlanBar({
      alternatives,
      selectedPlanIndex: 0,
      fallbackTotalUnits: 9,
      isInfeasible: false,
      onSelectPlan: (idx) => {
        selectedFromDropdown = idx;
      },
      onOpenCompare: () => {
        openCompareCalls += 1;
      },
    });

    const compareButtons = findElements(
      tree,
      (el) => el.type === 'button' && el.props.className === 'plan-bar__compare-btn'
    );
    assert.equal(compareButtons.length, 1);
    (compareButtons[0].props.onClick as () => void)();
    assert.equal(openCompareCalls, 1);

    // Quick-switcher dropdown still selects plans directly
    const selects = findElements(
      tree,
      (el) => el.type === 'select' && el.props.id === 'amisync-plan-select'
    );
    assert.equal(selects.length, 1);
    (selects[0].props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '2' },
    });
    assert.equal(selectedFromDropdown, 2);
  });

  it('renders mode-aware PlanComparisonModal (Overlay mini timetables vs 800x600 Popup summary cards) and wires selection & dismissal', async () => {
    const { plan, alternatives } = makeSamplePlanWithAlternatives();
    const { PlanComparisonModal } = await loadTsxComponent<{
      PlanComparisonModal: React.ComponentType<{
        isOpen: boolean;
        isCompactPopup: boolean;
        canExpandOverlay: boolean;
        plan: AcademicPlanState;
        alternatives: readonly GeneratedScheduleAlternative[];
        selectedPlanIndex: number;
        onSelectPlan: (index: number) => void;
        onClose: () => void;
        onOpenOverlayCompare?: () => void;
      }>;
    }>('src/components/PlanComparisonModal.tsx');

    // 1. Overlay Mode with 3 plans -> grid-cols-3, mini timetable grids (MON-SAT, 7-8 to 6-7), metrics, sections, Select Plan
    const overlay3Html = renderToStaticMarkup(
      React.createElement(PlanComparisonModal, {
        isOpen: true,
        isCompactPopup: false,
        canExpandOverlay: false,
        plan,
        alternatives,
        selectedPlanIndex: 0,
        onSelectPlan: () => undefined,
        onClose: () => undefined,
      })
    );
    assert.ok(overlay3Html.includes('role="dialog"'));
    assert.ok(overlay3Html.includes('aria-modal="true"'));
    assert.ok(overlay3Html.includes('Compare Generated Plans'));
    assert.ok(overlay3Html.includes('compare-modal__grid grid-cols-3'));
    assert.ok(overlay3Html.includes('Plan A • Recommended / Optimal'));
    assert.ok(overlay3Html.includes('>Plan B<'));
    assert.ok(overlay3Html.includes('>Plan C<'));
    assert.ok(overlay3Html.includes('9 Units'));
    assert.ok(overlay3Html.includes('mini-timetable__grid'));
    assert.ok(overlay3Html.includes('>MON<'));
    assert.ok(overlay3Html.includes('>SAT<'));
    assert.ok(overlay3Html.includes('>7-8<'));
    assert.ok(overlay3Html.includes('>6-7<'));
    assert.ok(overlay3Html.includes('1.5 hrs'));
    assert.ok(overlay3Html.includes('7:00 AM – 12:30 PM'));
    assert.ok(overlay3Html.includes('2/2 starred'));
    assert.ok(overlay3Html.includes('AB-1L'));
    assert.ok(overlay3Html.includes('CD-2L'));
    assert.ok(overlay3Html.includes('EF-3L'));
    // Mini timetable blocks display course code + SEC <section>
    assert.ok(overlay3Html.includes('class="mini-timetable__block-label">CMSC 128</span><span class="mini-timetable__block-section">SEC AB-1L</span>'));
    assert.ok(overlay3Html.includes('class="mini-timetable__block-label">CMSC 128</span><span class="mini-timetable__block-section">SEC CD-2L</span>'));
    assert.ok(overlay3Html.includes('class="mini-timetable__block-label">CMSC 128</span><span class="mini-timetable__block-section">SEC EF-3L</span>'));
    // CHOSEN SECTIONS keeps Course + SEC pill paired together with schedule summary on the right
    assert.ok(overlay3Html.includes('compare-course-item__primary'));
    assert.ok(overlay3Html.includes('compare-course-item__code">CMSC 128</span><span class="compare-course-item__section-pill" title="CMSC 128 — SEC AB-1L">SEC AB-1L</span>'));
    assert.ok(overlay3Html.includes('compare-course-item__schedule" title="TTh 8:00–9:30 AM">TTh 8:00–9:30 AM</span>'));
    assert.equal((overlay3Html.match(/>Select Plan</g) ?? []).length, 3);
    assert.ok(!overlay3Html.includes('Open Full Visual Compare in Overlay'));

    // 2. Overlay Mode with 2 plans -> grid-cols-2 (and 3-hour block includes room code)
    const longLabPlan: AcademicPlanState = {
      ...plan,
      intendedCourses: [
        makeCourse('191', 'CMSC 191', 3, [
          {
            id: '191-EF',
            section: 'EF',
            days: ['Monday'],
            startMinutes: 780, // 1:00 PM - 4:00 PM (3 hrs -> room shown)
            endMinutes: 960,
            location: 'ICS PC1',
          },
          {
            id: '191-WX',
            section: 'WX',
            days: ['Wednesday'],
            startMinutes: 780,
            endMinutes: 960,
            location: 'ICS PC2',
          },
        ]),
      ],
    };
    const longLabAlts: GeneratedScheduleAlternative[] = [
      { ...alternatives[0], selectedSectionIds: ['165-S', '191-EF'] },
      { ...alternatives[1], selectedSectionIds: ['165-S', '191-WX'] },
    ];
    const overlay2Html = renderToStaticMarkup(
      React.createElement(PlanComparisonModal, {
        isOpen: true,
        isCompactPopup: false,
        canExpandOverlay: false,
        plan: longLabPlan,
        alternatives: longLabAlts,
        selectedPlanIndex: 0,
        onSelectPlan: () => undefined,
        onClose: () => undefined,
      })
    );
    assert.ok(overlay2Html.includes('compare-modal__grid grid-cols-2'));
    assert.ok(overlay2Html.includes('class="mini-timetable__block-label">CMSC 191</span><span class="mini-timetable__block-section">SEC EF</span><span class="mini-timetable__block-room">ICS PC1</span>'));
    assert.ok(overlay2Html.includes('class="mini-timetable__block-label">CMSC 191</span><span class="mini-timetable__block-section">SEC WX</span><span class="mini-timetable__block-room">ICS PC2</span>'));
    assert.equal((overlay2Html.match(/>Select Plan</g) ?? []).length, 2);

    // 3. 800x600 Popup Mode with 3 plans -> compact summary cards with paired Course + SEC pill & schedule
    const popup3Html = renderToStaticMarkup(
      React.createElement(PlanComparisonModal, {
        isOpen: true,
        isCompactPopup: true,
        canExpandOverlay: true,
        plan,
        alternatives,
        selectedPlanIndex: 1,
        onSelectPlan: () => undefined,
        onClose: () => undefined,
        onOpenOverlayCompare: () => undefined,
      })
    );
    assert.ok(popup3Html.includes('compare-modal--popup'));
    assert.ok(popup3Html.includes('compare-modal__grid grid-cols-3'));
    assert.ok(!popup3Html.includes('mini-timetable__grid'));
    assert.ok(popup3Html.includes('compare-course-item__code">CMSC 128</span><span class="compare-course-item__section-pill" title="CMSC 128 — SEC CD-2L">SEC CD-2L</span>'));
    assert.ok(popup3Html.includes('Open Full Visual Compare in Overlay'));
    assert.ok(popup3Html.includes('1.5 hrs'));
    assert.ok(popup3Html.includes('2/2 starred'));
    assert.equal((popup3Html.match(/>Select Plan</g) ?? []).length, 3);

    // 4. Closed or < 2 alternatives -> renders empty
    const closedHtml = renderToStaticMarkup(
      React.createElement(PlanComparisonModal, {
        isOpen: false,
        isCompactPopup: false,
        canExpandOverlay: false,
        plan,
        alternatives,
        selectedPlanIndex: 0,
        onSelectPlan: () => undefined,
        onClose: () => undefined,
      })
    );
    assert.equal(closedHtml, '');

    const singleAltHtml = renderToStaticMarkup(
      React.createElement(PlanComparisonModal, {
        isOpen: true,
        isCompactPopup: false,
        canExpandOverlay: false,
        plan,
        alternatives: [alternatives[0]],
        selectedPlanIndex: 0,
        onSelectPlan: () => undefined,
        onClose: () => undefined,
      })
    );
    assert.equal(singleAltHtml, '');

    // 5. CSS enforces zero outer scrollbars and equal-width grid columns in both modes
    const css = fs.readFileSync(path.join(EXT_ROOT, 'src/styles/index.css'), 'utf8');
    assert.match(css, /\.compare-modal-backdrop\s*\{[\s\S]*?overflow:\s*hidden;/);
    assert.match(css, /\.compare-modal\s*\{[\s\S]*?overflow:\s*hidden;/);
    assert.match(css, /\.compare-modal--popup\s*\{[\s\S]*?max-width:\s*780px;[\s\S]*?max-height:\s*580px;/);
    assert.match(css, /\.compare-modal__grid\s*\{[\s\S]*?overflow:\s*hidden;/);
    assert.match(css, /\.compare-modal__grid\.grid-cols-2\s*\{[\s\S]*?repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
    assert.match(css, /\.compare-modal__grid\.grid-cols-3\s*\{[\s\S]*?repeat\(3,\s*minmax\(0,\s*1fr\)\);/);
  });

  it('persists and consumes one-shot popup-to-overlay compare handoffs via chrome.storage.local', async () => {
    const { alternatives } = makeSamplePlanWithAlternatives();
    const { storage, raw } = createMemoryStorage();

    await saveCompareHandoff(alternatives, 1, storage, 10_000);
    assert.equal(raw.has(COMPARE_HANDOFF_STORAGE_KEY), true);

    const consumed = await consumeCompareHandoff(storage, 15_000);
    assert.ok(consumed);
    assert.equal(consumed.alternatives.length, 3);
    assert.equal(consumed.selectedPlanIndex, 1);
    assert.equal(raw.has(COMPARE_HANDOFF_STORAGE_KEY), false, 'Handoff must be cleared after consume');

    // Second consume returns null
    assert.equal(await consumeCompareHandoff(storage, 16_000), null);

    // Expired handoff (> 60s old) is discarded
    await saveCompareHandoff(alternatives, 0, storage, 10_000);
    assert.equal(await consumeCompareHandoff(storage, 90_000), null);
    assert.equal(raw.has(COMPARE_HANDOFF_STORAGE_KEY), false);
  });
});
