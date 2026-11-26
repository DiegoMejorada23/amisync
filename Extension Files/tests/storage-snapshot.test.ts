import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isAmisError } from '../src/amis/errors.ts';
import { exportPlanSnapshot, parsePlanSnapshot } from '../src/amis/snapshot.ts';
import { DEFAULT_FALLBACK_TERMS } from '../src/amis/terms.ts';
import {
  AUTO_REFRESH_INTERVAL_MS,
  canManualRefresh,
  clearAcademicPlan,
  loadAcademicPlan,
  loadTermCatalog,
  MANUAL_REFRESH_COOLDOWN_MS,
  PLAN_STORAGE_KEY,
  saveAcademicPlan,
  saveTermCatalog,
  shouldAutoRefresh,
  TERM_CATALOG_STORAGE_KEY,
  type StorageAreaLike,
} from '../src/storage/planStorage.ts';
import { createDefaultAcademicPlanState, PRIORITY_WEIGHT_MAP } from '../src/types/domain.ts';

function createMemoryStorage(initial: Record<string, unknown> = {}): StorageAreaLike {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    async get(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of keyList) {
        if (store.has(key)) {
          out[key] = store.get(key);
        }
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, v);
      }
    },
    async remove(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        store.delete(key);
      }
    },
  };
}

describe('Domain constants & Snapshot serialization', () => {
  it('exposes exact thesis preference weight mappings', () => {
    assert.deepEqual(PRIORITY_WEIGHT_MAP, {
      Off: 0,
      Low: 2,
      Medium: 5,
      High: 10,
    });
  });

  it('round-trips AcademicPlanState through JSON snapshots', () => {
    const plan = createDefaultAcademicPlanState();
    plan.termId = 123;
    plan.preferences.includeFullSections = true;
    plan.blockedCells.push({
      id: 'Tuesday:780-840',
      day: 'Tuesday',
      startMinutes: 780,
      endMinutes: 840,
    });

    const json = exportPlanSnapshot(plan, {
      tier: 'Small',
      capturedAt: '2026-11-23T12:00:00.000Z',
    });
    const parsed = parsePlanSnapshot(json);

    assert.equal(parsed.tier, 'Small');
    assert.equal(parsed.capturedAt, '2026-11-23T12:00:00.000Z');
    assert.equal(parsed.plan.termId, 123);
    assert.equal(parsed.plan.blockedCells.length, 1);
    assert.equal(parsed.plan.preferences.minimizeExcessiveGaps.gapThresholdMinutes, 120);
    assert.equal(parsed.plan.preferences.includeFullSections, true);
  });

  it('rejects malformed snapshot JSON or invalid schema with MALFORMED_RESPONSE', () => {
    assert.throws(
      () => parsePlanSnapshot('{not valid json'),
      (err: unknown) => isAmisError(err) && err.code === 'MALFORMED_RESPONSE'
    );

    assert.throws(
      () => parsePlanSnapshot({ schemaVersion: '1.0.0', capturedAt: '2026-11-23', plan: {} }),
      (err: unknown) => isAmisError(err) && err.code === 'MALFORMED_RESPONSE'
    );
  });
});

describe('chrome.storage.local plan persistence & refresh timers', () => {
  it('saves, loads, and clears AcademicPlanState and falls back gracefully when corrupted', async () => {
    const storage = createMemoryStorage();

    const emptyLoad = await loadAcademicPlan(storage);
    assert.equal(emptyLoad.termId, null);
    assert.deepEqual(emptyLoad.intendedCourses, []);

    const customPlan = createDefaultAcademicPlanState();
    customPlan.termId = 456;
    customPlan.lastRefreshTime = '2026-11-23T10:00:00.000Z';
    await saveAcademicPlan(customPlan, storage);

    const loaded = await loadAcademicPlan(storage);
    assert.equal(loaded.termId, 456);
    assert.equal(loaded.lastRefreshTime, '2026-11-23T10:00:00.000Z');

    await clearAcademicPlan(storage);
    const afterClear = await loadAcademicPlan(storage);
    assert.equal(afterClear.termId, null);

    const corruptedStorage = createMemoryStorage({
      [PLAN_STORAGE_KEY]: { schemaVersion: '0.0.1', broken: true },
    });
    const recovered = await loadAcademicPlan(corruptedStorage);
    assert.equal(recovered.schemaVersion, customPlan.schemaVersion);
    assert.equal(recovered.termId, null);
  });

  it('enforces 30-minute manual cooldown and 4-hour auto-refresh intervals', () => {
    const baseTime = new Date('2026-11-23T12:00:00.000Z');

    assert.deepEqual(canManualRefresh(null, baseTime), { allowed: true, remainingMs: 0 });
    assert.equal(shouldAutoRefresh(null, baseTime), true);

    const tenMinutesAgo = new Date(baseTime.getTime() - 10 * 60 * 1000).toISOString();
    const cooldownState = canManualRefresh(tenMinutesAgo, baseTime);
    assert.equal(cooldownState.allowed, false);
    assert.equal(cooldownState.remainingMs, MANUAL_REFRESH_COOLDOWN_MS - 10 * 60 * 1000);
    assert.equal(shouldAutoRefresh(tenMinutesAgo, baseTime), false);

    const thirtyMinutesAgo = new Date(baseTime.getTime() - MANUAL_REFRESH_COOLDOWN_MS).toISOString();
    assert.deepEqual(canManualRefresh(thirtyMinutesAgo, baseTime), { allowed: true, remainingMs: 0 });

    const fourHoursAgo = new Date(baseTime.getTime() - AUTO_REFRESH_INTERVAL_MS).toISOString();
    assert.equal(shouldAutoRefresh(fourHoursAgo, baseTime), true);
  });

  it('persists, loads, and self-heals the discovered term catalog in chrome.storage.local', async () => {
    const storage = createMemoryStorage();
    const initial = await loadTermCatalog(storage);
    assert.deepEqual(
      initial.map((t) => t.termId),
      DEFAULT_FALLBACK_TERMS.map((t) => t.termId)
    );

    await saveTermCatalog(
      [
        {
          termId: 1281,
          label: '1281 - 1st Sem (2028-2029)',
          shortLabel: '1st Sem (2028-2029)',
          isMidyear: false,
          source: 'api',
        },
      ],
      storage
    );

    const loaded = await loadTermCatalog(storage);
    assert.equal(loaded[0].termId, 1281);
    assert.equal(loaded[0].source, 'api');
    assert.ok(loaded.some((t) => t.termId === 1261));

    const corruptStorage = createMemoryStorage({
      [TERM_CATALOG_STORAGE_KEY]: { invalid: true },
    });
    const healed = await loadTermCatalog(corruptStorage);
    assert.deepEqual(
      healed.map((t) => t.termId),
      DEFAULT_FALLBACK_TERMS.map((t) => t.termId)
    );
  });
});
