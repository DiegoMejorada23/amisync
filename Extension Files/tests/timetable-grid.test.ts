import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  saveAcademicPlan,
  type StorageAreaLike,
} from '../src/storage/planStorage.ts';
import {
  createDefaultAcademicPlanState,
  type AcademicPlanState,
  type CourseEntry,
} from '../src/types/domain.ts';
import {
  applyBlockedCellsRange,
  toggleBlockedCell,
} from '../src/ui/planActions.ts';
import { getTimetableCellRange } from '../src/ui/scheduleView.ts';
import {
  getDragPreviewCellKeys,
  TimetableDragController,
  type TimetableDragSession,
} from '../src/ui/timetableDrag.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_ROOT = path.resolve(__dirname, '..');
const TEMP_DIR = path.join(EXT_ROOT, 'node_modules', '.vite-temp');

function makePreEnlistedCourse(): CourseEntry {
  return {
    instanceId: 'pre-cmsc-165',
    id: '165',
    code: 'CMSC 165',
    units: 3,
    canEnrollMultiple: false,
    isPreEnlisted: true,
    requiredComponents: ['LEC', 'LAB'],
    isExpanded: true,
    sections: [
      {
        isPreEnlisted: true,
        flags: { isHidden: false, isLocked: false, isStarred: false },
        section: {
          id: '165-lab',
          courseId: '165',
          section: 'S-4L',
          activity: 'LAB',
          faculties: [],
          location: 'ICS PC7',
          dates: [
            {
              days: ['Friday'],
              startTime: '07:00 AM',
              endTime: '10:00 AM',
              startMinutes: 420,
              endMinutes: 600,
            },
          ],
          activeClassSize: 20,
          maxClassSize: 20,
          isPrerogOpen: false,
          parentClassId: '165-lec',
          parentClass: {
            id: '165-lec',
            courseId: '165',
            section: 'S',
            activity: 'LEC',
            faculties: [],
            location: 'SMA LH',
            dates: [
              {
                days: ['Tuesday', 'Thursday'],
                startTime: '07:00 AM',
                endTime: '08:00 AM',
                startMinutes: 420,
                endMinutes: 480,
              },
            ],
            activeClassSize: 60,
            maxClassSize: 60,
            isPrerogOpen: false,
            parentClassId: null,
            parentClass: null,
          },
        },
      },
    ],
  };
}

function createCountingMemoryStorage(): {
  storage: StorageAreaLike;
  getSetCount: () => number;
  getLastSavedPlan: () => AcademicPlanState | null;
} {
  const store = new Map<string, unknown>();
  let setCount = 0;
  let lastSaved: AcademicPlanState | null = null;

  const storage: StorageAreaLike = {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) {
        if (store.has(k)) {
          out[k] = structuredClone(store.get(k));
        }
      }
      return out;
    },
    async set(items) {
      setCount += 1;
      for (const [k, v] of Object.entries(items)) {
        store.set(k, structuredClone(v));
        lastSaved = structuredClone(v) as AcademicPlanState;
      }
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        store.delete(k);
      }
    },
  };

  return {
    storage,
    getSetCount: () => setCount,
    getLastSavedPlan: () => lastSaved,
  };
}

const tempFilesToClean: string[] = [];

async function loadTsxComponent<TModule>(relativeSrcPath: string): Promise<TModule> {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const outfile = path.join(
    TEMP_DIR,
    `test-bundle-${path.basename(relativeSrcPath, '.tsx')}-${Date.now()}-${Math.random()
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

describe('Timetable Slot Blocking: Tab Gating & Click-and-Drag Range Selection', () => {
  it('computes single-cell, vertical, and multi-day rectangular ranges regardless of drag direction', () => {
    const single = getTimetableCellRange(
      { day: 'Monday', startMinutes: 420 },
      { day: 'Monday', startMinutes: 420 }
    );
    assert.deepEqual(single, [{ day: 'Monday', startMinutes: 420 }]);

    // Single-day vertical drag (upward from 3-4 PM to 1-2 PM)
    const vertical = getTimetableCellRange(
      { day: 'Tuesday', startMinutes: 900 },
      { day: 'Tuesday', startMinutes: 780 }
    );
    assert.deepEqual(vertical, [
      { day: 'Tuesday', startMinutes: 780 },
      { day: 'Tuesday', startMinutes: 840 },
      { day: 'Tuesday', startMinutes: 900 },
    ]);

    // Multi-day rectangular drag (bottom-right Thursday 2-3 PM -> top-left Tuesday 1-2 PM)
    const rect = getTimetableCellRange(
      { day: 'Thursday', startMinutes: 840 },
      { day: 'Tuesday', startMinutes: 780 }
    );
    assert.deepEqual(rect, [
      { day: 'Tuesday', startMinutes: 780 },
      { day: 'Tuesday', startMinutes: 840 },
      { day: 'Wednesday', startMinutes: 780 },
      { day: 'Wednesday', startMinutes: 840 },
      { day: 'Thursday', startMinutes: 780 },
      { day: 'Thursday', startMinutes: 840 },
    ]);
  });

  it('applies batch block/unblock ranges while skipping pre-enlisted locked slots and no-ops', () => {
    let plan = createDefaultAcademicPlanState();
    plan.preEnlistedCourses = [makePreEnlistedCourse()];

    // Drag Monday..Tuesday 7-8 AM (Tuesday 7-8 AM is locked by CMSC 165)
    const blockRange = getTimetableCellRange(
      { day: 'Monday', startMinutes: 420 },
      { day: 'Tuesday', startMinutes: 420 }
    );
    const afterBlock = applyBlockedCellsRange(plan, blockRange, 'block');
    assert.notEqual(afterBlock, plan);
    assert.deepEqual(
      afterBlock.blockedCells.map((c) => c.id),
      ['Monday:420-480']
    );

    // Repeating the same block action is a reference-equal no-op
    const redundantBlock = applyBlockedCellsRange(afterBlock, blockRange, 'block');
    assert.equal(redundantBlock, afterBlock);

    // Unblocking a range removes only matching unlocked blocked cells
    plan = toggleBlockedCell(afterBlock, 'Wednesday', 420);
    const afterUnblock = applyBlockedCellsRange(
      plan,
      [{ day: 'Monday', startMinutes: 420 }],
      'unblock'
    );
    assert.deepEqual(
      afterUnblock.blockedCells.map((c) => c.id),
      ['Wednesday:420-480']
    );
  });

  it('gates TimetableGrid interaction and affordances by active tab while preserving visual blocked slots', async () => {
    const { TimetableGrid } = await loadTsxComponent<{
      TimetableGrid: React.ComponentType<{
        plan: AcademicPlanState;
        activeAlternative: null;
        isSolving: boolean;
        isBlockingEnabled: boolean;
        onToggleCell: () => void;
        onCommitBlockedRange: () => void;
      }>;
    }>('src/components/TimetableGrid.tsx');

    let plan = createDefaultAcademicPlanState();
    plan.preEnlistedCourses = [makePreEnlistedCourse()];
    plan = toggleBlockedCell(plan, 'Tuesday', 780);

    // 1. Courses tab active (isBlockingEnabled = false):
    // Existing blocked slots still render visually, while all grid slots are disabled/readonly.
    const coursesHtml = renderToStaticMarkup(
      React.createElement(TimetableGrid, {
        plan,
        activeAlternative: null,
        isSolving: false,
        isBlockingEnabled: false,
        onToggleCell: () => undefined,
        onCommitBlockedRange: () => undefined,
      })
    );
    assert.ok(coursesHtml.includes('timetable-grid--readonly'));
    assert.ok(!coursesHtml.includes('timetable-grid--editable'));
    assert.ok(coursesHtml.includes('timetable-slot--blocked'));
    assert.ok(coursesHtml.includes('BLOCKED'));
    assert.ok(coursesHtml.includes('timetable-slot--readonly'));
    assert.ok(!coursesHtml.includes('Click or drag to block'));
    assert.ok(!coursesHtml.includes('Click or drag to unblock'));
    const disabledCountCourses = (coursesHtml.match(/disabled=""/g) ?? []).length;
    assert.equal(disabledCountCourses, 72, 'All 72 slots should be disabled on Courses tab');

    // 2. Preferences & Weights tab active (isBlockingEnabled = true):
    // Unlocked slots become interactive while pre-enlisted locked slots stay disabled.
    const prefsHtml = renderToStaticMarkup(
      React.createElement(TimetableGrid, {
        plan,
        activeAlternative: null,
        isSolving: false,
        isBlockingEnabled: true,
        onToggleCell: () => undefined,
        onCommitBlockedRange: () => undefined,
      })
    );
    assert.ok(prefsHtml.includes('timetable-grid--editable'));
    assert.ok(!prefsHtml.includes('timetable-grid--readonly'));
    assert.ok(!prefsHtml.includes('timetable-slot--readonly'));
    assert.ok(prefsHtml.includes('Tuesday 1-2: Blocked. Click or drag to unblock.'));
    assert.ok(prefsHtml.includes('Monday 7-8: Available. Click or drag to block.'));
    const disabledCountPrefs = (prefsHtml.match(/disabled=""/g) ?? []).length;
    // Pre-enlisted CMSC 165 occupies Tue 7-8 (1), Thu 7-8 (1), Fri 7-10 (3) = 5 locked slots
    assert.equal(disabledCountPrefs, 5, 'Only the 5 pre-enlisted slots should remain disabled');

    // 3. Default App shell starts on Courses tab with timetable blocking disabled.
    const { default: App } = await loadTsxComponent<{ default: React.ComponentType }>(
      'src/App.tsx'
    );
    const appHtml = renderToStaticMarkup(React.createElement(App));
    assert.ok(appHtml.includes('aria-selected="true" class="right-tabs__btn right-tabs__btn--active">Courses</button>'));
    assert.ok(appHtml.includes('timetable-grid--readonly'));

    // 4. CSS scopes clickable cursor & hover affordances strictly to editable mode.
    const css = fs.readFileSync(path.join(EXT_ROOT, 'src/styles/index.css'), 'utf8');
    assert.match(css, /\.timetable-slot\s*\{[\s\S]*?cursor:\s*default;/);
    assert.match(css, /\.timetable-grid--editable\s+\.timetable-slot:not\(:disabled\)\s*\{[\s\S]*?cursor:\s*pointer;/);
    assert.match(css, /\.timetable-grid--editable\s+\.timetable-slot:hover:not\(:disabled\)/);
    assert.match(css, /\.timetable-grid--dragging\s+\.timetable-block\s*\{[\s\S]*?pointer-events:\s*none;/);
  });

  it('blocks dragging and clicking when Courses tab is active', () => {
    let plan = createDefaultAcademicPlanState();
    let commitCalls = 0;
    let toggleCalls = 0;

    const controller = new TimetableDragController({
      isBlockingEnabled: false,
      onSessionChange: () => undefined,
      onCommitRange: () => {
        commitCalls += 1;
      },
      onToggleCell: () => {
        toggleCalls += 1;
      },
    });

    const docTarget = new EventTarget();
    const winTarget = new EventTarget();
    const detach = controller.attachGlobalListeners([docTarget, winTarget]);

    const started = controller.handlePointerDown({
      day: 'Monday',
      startMinutes: 780,
      isLocked: false,
      isBlocked: false,
      button: 0,
      pointerId: 1,
    });
    assert.equal(started, false);
    assert.equal(controller.getSession(), null);

    controller.handlePointerEnter({ day: 'Monday', startMinutes: 840 });
    winTarget.dispatchEvent(new Event('pointerup'));
    controller.handleClick({ day: 'Monday', startMinutes: 780, isLocked: false });

    assert.equal(commitCalls, 0);
    assert.equal(toggleCalls, 0);
    assert.equal(plan.blockedCells.length, 0);
    detach();
  });

  it('supports click-and-drag block/unblock, single-write storage commit, outside release cleanup, and click deduplication', async () => {
    let plan = createDefaultAcademicPlanState();
    plan.preEnlistedCourses = [makePreEnlistedCourse()];

    const { storage, getSetCount, getLastSavedPlan } = createCountingMemoryStorage();
    let activeSession: TimetableDragSession | null = null;
    const getObservedSession = (): TimetableDragSession | null => activeSession;
    let commitCalls = 0;
    let toggleCalls = 0;

    const controller = new TimetableDragController({
      isBlockingEnabled: true,
      onSessionChange: (session) => {
        activeSession = session;
      },
      onCommitRange: (cells, mode) => {
        commitCalls += 1;
        const next = applyBlockedCellsRange(plan, cells, mode);
        if (next !== plan) {
          plan = next;
          void saveAcademicPlan(plan, storage);
        }
      },
      onToggleCell: (day, startMinutes) => {
        toggleCalls += 1;
        const next = toggleBlockedCell(plan, day, startMinutes);
        if (next !== plan) {
          plan = next;
          void saveAcademicPlan(plan, storage);
        }
      },
    });

    const docTarget = new EventTarget();
    const winTarget = new EventTarget();
    const detach = controller.attachGlobalListeners([docTarget, winTarget]);

    // 1. Multi-day rectangular drag starting on an unblocked cell (Tuesday 1-2 PM -> Wednesday 3-4 PM)
    assert.equal(
      controller.handlePointerDown({
        day: 'Tuesday',
        startMinutes: 780,
        isLocked: false,
        isBlocked: false,
        button: 0,
        pointerId: 1,
      }),
      true
    );
    assert.equal(getObservedSession()?.mode, 'block');

    // Sweeping across intermediate cells updates preview only (0 storage writes mid-drag)
    controller.handlePointerEnter({ day: 'Tuesday', startMinutes: 840 });
    controller.handlePointerEnter({ day: 'Wednesday', startMinutes: 840 });
    controller.handlePointerEnter({ day: 'Wednesday', startMinutes: 900 });

    const previewKeys = getDragPreviewCellKeys(plan, getObservedSession());
    assert.equal(previewKeys.size, 6);
    assert.equal(commitCalls, 0, 'Should not commit on pointerenter');
    assert.equal(getSetCount(), 0, 'Should not write to chrome.storage.local during drag');

    // Releasing outside the grid on window commits once and clears drag state
    winTarget.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(getObservedSession(), null);
    assert.equal(controller.getSession(), null);
    assert.equal(commitCalls, 1);
    assert.equal(getSetCount(), 1, 'Expected exactly 1 chrome.storage.local write after drag');
    assert.equal(plan.blockedCells.length, 6);
    assert.equal(getLastSavedPlan()?.blockedCells.length, 6);

    // 2. Drag starting on an already-blocked cell unblocks the entire dragged range (even mixed blocked/unblocked)
    controller.handlePointerDown({
      day: 'Tuesday',
      startMinutes: 780,
      isLocked: false,
      isBlocked: true,
      button: 0,
      pointerId: 2,
    });
    assert.equal(getObservedSession()?.mode, 'unblock');
    controller.handlePointerEnter({ day: 'Thursday', startMinutes: 840 });
    docTarget.dispatchEvent(Object.assign(new Event('pointerup', { bubbles: true }), { pointerId: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(getObservedSession(), null);
    assert.equal(commitCalls, 2);
    assert.equal(getSetCount(), 2);
    // Tuesday 1-3 & Wednesday 1-3 were unblocked; Wednesday 3-4 & Tuesday 3-4 remain blocked (2 cells)
    assert.deepEqual(
      plan.blockedCells.map((c) => c.id),
      ['Tuesday:900-960', 'Wednesday:900-960']
    );

    // 3. Single click: pointerDown -> pointerUp -> immediate trailing click must NOT double-fire
    controller.handlePointerDown({
      day: 'Monday',
      startMinutes: 780,
      isLocked: false,
      isBlocked: false,
      button: 0,
      pointerId: 3,
    });
    winTarget.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 3 }));
    const clickHandled = controller.handleClick({
      day: 'Monday',
      startMinutes: 780,
      isLocked: false,
    });
    assert.equal(clickHandled, false, 'Trailing synthetic click after pointerup must be suppressed');
    assert.equal(toggleCalls, 0);
    assert.equal(commitCalls, 3);
    assert.ok(plan.blockedCells.some((c) => c.id === 'Monday:780-840'));

    // 4. Subsequent keyboard click (without pointerDown) still toggles cleanly
    await new Promise((resolve) => setTimeout(resolve, 10));
    const keyboardClickHandled = controller.handleClick({
      day: 'Monday',
      startMinutes: 780,
      isLocked: false,
    });
    assert.equal(keyboardClickHandled, true);
    assert.equal(toggleCalls, 1);
    assert.ok(!plan.blockedCells.some((c) => c.id === 'Monday:780-840'));

    // 5. Switching tab to Courses mid-drag cancels drag without committing
    controller.handlePointerDown({
      day: 'Monday',
      startMinutes: 840,
      isLocked: false,
      isBlocked: false,
      button: 0,
      pointerId: 4,
    });
    assert.ok(controller.getSession() !== null);
    controller.updateOptions({
      isBlockingEnabled: false,
      onSessionChange: (s) => {
        activeSession = s;
      },
      onCommitRange: () => {
        commitCalls += 1;
      },
      onToggleCell: () => {
        toggleCalls += 1;
      },
    });
    assert.equal(controller.getSession(), null);
    assert.equal(activeSession, null);
    assert.equal(commitCalls, 3);

    detach();
  });
});
