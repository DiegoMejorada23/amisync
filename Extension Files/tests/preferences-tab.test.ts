import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  loadAcademicPlan,
  saveAcademicPlan,
  type StorageAreaLike,
} from '../src/storage/planStorage.ts';
import {
  createDefaultAcademicPlanState,
  type CourseEntry,
  type StudentPreferences,
} from '../src/types/domain.ts';
import {
  PREFERENCES_SAVED_STATUS_MESSAGE,
  savePreferencesAndReturnToCourses,
  toggleBlockedCell,
  updatePreferences,
} from '../src/ui/planActions.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_ROOT = path.resolve(__dirname, '..');
const TEMP_DIR = path.join(EXT_ROOT, 'node_modules', '.vite-temp');

const tempFilesToClean: string[] = [];

async function loadTsxComponent<TModule>(relativeSrcPath: string): Promise<TModule> {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const outfile = path.join(
    TEMP_DIR,
    `test-prefs-${path.basename(relativeSrcPath, '.tsx')}-${Date.now()}-${Math.random()
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

function createCountingMemoryStorage(): {
  storage: StorageAreaLike;
  getSetCount: () => number;
} {
  const store = new Map<string, unknown>();
  let setCount = 0;

  const storage: StorageAreaLike = {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) {
        if (store.has(key)) {
          out[key] = structuredClone(store.get(key));
        }
      }
      return out;
    },
    async set(items) {
      setCount += 1;
      for (const [key, value] of Object.entries(items)) {
        store.set(key, structuredClone(value));
      }
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        store.delete(key);
      }
    },
  };

  return {
    storage,
    getSetCount: () => setCount,
  };
}

function collectElements(
  node: React.ReactNode,
  predicate: (el: React.ReactElement<Record<string, unknown>>) => boolean,
  out: React.ReactElement<Record<string, unknown>>[] = []
): React.ReactElement<Record<string, unknown>>[] {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') {
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectElements(child, predicate, out);
    }
    return out;
  }
  if (React.isValidElement<Record<string, unknown>>(node)) {
    if (predicate(node)) {
      out.push(node);
    }
    if (typeof node.type === 'function') {
      const rendered = (node.type as (props: Record<string, unknown>) => React.ReactNode)(
        node.props
      );
      collectElements(rendered, predicate, out);
    } else if (node.props && 'children' in node.props) {
      collectElements(node.props.children as React.ReactNode, predicate, out);
    }
  }
  return out;
}

function textContent(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textContent).join('');
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return textContent(node.props.children);
  }
  return '';
}

function makeSampleCourse(): CourseEntry {
  return {
    instanceId: 'inst-cmsc-128',
    id: '128',
    code: 'CMSC 128',
    termId: 1261,
    units: 3,
    canEnrollMultiple: false,
    isPreEnlisted: false,
    requiredComponents: ['LEC'],
    isExpanded: true,
    sections: [
      {
        isPreEnlisted: false,
        flags: { isHidden: false, isLocked: false, isStarred: false },
        section: {
          id: '128-a',
          courseId: '128',
          termId: 1261,
          section: 'A',
          activity: 'LEC',
          faculties: [],
          location: 'ICS LH3',
          dates: [
            {
              days: ['Tuesday', 'Thursday'],
              startTime: '08:00 AM',
              endTime: '09:30 AM',
              startMinutes: 480,
              endMinutes: 570,
            },
          ],
          activeClassSize: 10,
          maxClassSize: 30,
          isPrerogOpen: false,
          parentClassId: null,
          parentClass: null,
        },
      },
    ],
  };
}

describe('Preferences & Weights Decoupled Save Flow', () => {
  it('renders Save & Apply Preferences CTA in PreferencesTab, updates edits live, and triggers save callback without solver state', async () => {
    const { PreferencesTab } = await loadTsxComponent<{
      PreferencesTab: (props: {
        preferences: StudentPreferences;
        onChangePreferences: (updater: (prev: StudentPreferences) => StudentPreferences) => void;
        onBack: () => void;
        onSavePreferences: () => void;
      }) => React.ReactElement;
    }>('src/components/PreferencesTab.tsx');

    let plan = createDefaultAcademicPlanState();
    const { storage, getSetCount } = createCountingMemoryStorage();
    let backCalls = 0;
    let saveCalls = 0;

    const handleChangePreferences = (
      updater: (prev: StudentPreferences) => StudentPreferences
    ) => {
      plan = updatePreferences(plan, updater);
      void saveAcademicPlan(plan, storage);
    };

    const html = renderToStaticMarkup(
      React.createElement(PreferencesTab, {
        preferences: plan.preferences,
        onChangePreferences: handleChangePreferences,
        onBack: () => {
          backCalls += 1;
        },
        onSavePreferences: () => {
          saveCalls += 1;
        },
      })
    );

    assert.ok(html.includes('Save &amp; Apply Preferences'));
    assert.ok(html.includes('>Back<'));
    assert.ok(!html.includes('Applying...'));

    // Inspect interactive elements returned by PreferencesTab and trigger live edits + CTA click.
    const tree = PreferencesTab({
      preferences: plan.preferences,
      onChangePreferences: handleChangePreferences,
      onBack: () => {
        backCalls += 1;
      },
      onSavePreferences: () => {
        saveCalls += 1;
      },
    });

    const selects = collectElements(
      tree,
      (el) => el.type === 'select' && el.props.id === 'pref-weight-friday'
    );
    assert.equal(selects.length, 1);
    (selects[0].props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'High' },
    });

    const sliders = collectElements(
      tree,
      (el) => el.type === 'input' && el.props.id === 'pref-slider-fatigue'
    );
    assert.equal(sliders.length, 1);
    (sliders[0].props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '4' },
    });

    const toggles = collectElements(
      tree,
      (el) => el.type === 'button' && el.props.id === 'pref-toggle-include-full'
    );
    assert.equal(toggles.length, 1);
    (toggles[0].props.onClick as () => void)();

    // Live updates already persisted immediately without needing button click
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(plan.preferences.minimizeFridayClasses.priority, 'High');
    assert.equal(plan.preferences.fatigueLimit.maxConsecutiveHours, 4);
    assert.equal(plan.preferences.includeFullSections, true);
    assert.equal(getSetCount(), 3);

    const persistedMidEdit = await loadAcademicPlan(storage);
    assert.equal(persistedMidEdit.preferences.minimizeFridayClasses.priority, 'High');
    assert.equal(persistedMidEdit.preferences.fatigueLimit.maxConsecutiveHours, 4);
    assert.equal(persistedMidEdit.preferences.includeFullSections, true);

    // Click the primary bottom CTA button
    const saveButtons = collectElements(
      tree,
      (el) =>
        el.type === 'button' &&
        typeof el.props.className === 'string' &&
        el.props.className.includes('btn-cta-primary')
    );
    assert.equal(saveButtons.length, 1);
    assert.equal(textContent(saveButtons[0]), 'Save & Apply Preferences');
    assert.equal(saveButtons[0].props.disabled, undefined);
    (saveButtons[0].props.onClick as () => void)();

    assert.equal(saveCalls, 1);
    assert.equal(backCalls, 0);
  });

  it('persists preferences, blocked slots, and toggles, switches to Courses tab, and shows confirmation without running solver or opening modal', async () => {
    const { CoursesTab } = await loadTsxComponent<{
      CoursesTab: React.ComponentType<Record<string, unknown>>;
    }>('src/components/CoursesTab.tsx');

    let plan = createDefaultAcademicPlanState();
    plan.termId = 1261;
    plan.intendedCourses = [makeSampleCourse()];

    const { storage, getSetCount } = createCountingMemoryStorage();
    let activeTab: 'courses' | 'preferences' = 'preferences';
    let statusMessage: string | null = null;
    let solverInvocations = 0;
    let compareModalOpened = false;

    // Simulate live user edits on Preferences & Weights + Timetable before clicking Save
    plan = updatePreferences(plan, (prev) => ({
      ...prev,
      fatigueLimit: { priority: 'High', maxConsecutiveHours: 3 },
      acceptableDayBounds: {
        priority: 'Medium',
        earliestStartMinutes: 540,
        latestEndMinutes: 1020,
      },
      includeFullSections: true,
    }));
    plan = toggleBlockedCell(plan, 'Wednesday', 780);
    await saveAcademicPlan(plan, storage);

    const setCountBeforeSaveButton = getSetCount();

    const savedPlan = savePreferencesAndReturnToCourses({
      currentPlan: plan,
      commitNormalizedPlan: (next) => {
        plan = next;
      },
      persistPlan: (planToSave) => saveAcademicPlan(planToSave, storage),
      switchToCoursesTab: () => {
        activeTab = 'courses';
      },
      showStatusMessage: (message) => {
        statusMessage = message;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(activeTab, 'courses');
    assert.equal(statusMessage, PREFERENCES_SAVED_STATUS_MESSAGE);
    assert.equal(solverInvocations, 0);
    assert.equal(compareModalOpened, false);
    assert.equal(getSetCount(), setCountBeforeSaveButton + 1);

    const loaded = await loadAcademicPlan(storage);
    assert.equal(loaded.preferences.fatigueLimit.maxConsecutiveHours, 3);
    assert.equal(loaded.preferences.acceptableDayBounds.earliestStartMinutes, 540);
    assert.equal(loaded.preferences.acceptableDayBounds.latestEndMinutes, 1020);
    assert.equal(loaded.preferences.includeFullSections, true);
    assert.equal(loaded.blockedCells.length, 1);
    assert.equal(loaded.blockedCells[0].id, 'Wednesday:780-840');
    assert.deepEqual(savedPlan.preferences, loaded.preferences);

    // Verify CoursesTab surfaces the non-intrusive status banner & full-sections badge
    // while keeping Generate Feasible Schedules ready for explicit user click.
    const coursesHtml = renderToStaticMarkup(
      React.createElement(CoursesTab, {
        intendedCourses: loaded.intendedCourses,
        preEnlistedCourses: loaded.preEnlistedCourses,
        selectedTermId: 1261,
        availableTerms: [],
        emptyTermSuggestion: null,
        authStatus: 'connected',
        isOffline: false,
        statusMessage,
        searchError: null,
        isSyncing: false,
        isAddingCourse: false,
        isSolving: false,
        isSolveBlocked: false,
        canGenerate: true,
        includeFullSections: Boolean(loaded.preferences.includeFullSections),
        onSelectTerm: () => undefined,
        onSyncAmis: () => undefined,
        onSearchSuggestions: async () => [],
        onAddCourseByCode: async () => false,
        onRemoveCourse: () => undefined,
        onToggleAccordion: () => undefined,
        onToggleSectionFlag: () => undefined,
        onSelectNstpTrackFilter: () => undefined,
        onGenerateSchedules: () => {
          solverInvocations += 1;
          compareModalOpened = true;
        },
        onCancelSolve: () => undefined,
      })
    );

    assert.ok(coursesHtml.includes('Preferences saved.'));
    assert.ok(coursesHtml.includes('amis-banner--info'));
    assert.ok(coursesHtml.includes('+ Full Sections Included'));
    assert.ok(coursesHtml.includes('GENERATE FEASIBLE SCHEDULES'));
  });

  it('wires App.tsx PreferencesTab to handleSavePreferences instead of runSolve', () => {
    const appSource = fs.readFileSync(path.join(EXT_ROOT, 'src/App.tsx'), 'utf8');
    assert.ok(appSource.includes('savePreferencesAndReturnToCourses'));
    assert.ok(appSource.includes('onSavePreferences={handleSavePreferences}'));
    assert.ok(!appSource.includes('handleApplyConstraints'));
    assert.ok(!appSource.includes('onApplyConstraints'));
  });
});
