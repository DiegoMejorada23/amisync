import { validateAcademicPlanState } from '../amis/snapshot.ts';
import type { AcademicPlanState } from '../types/domain.ts';
import { createDefaultAcademicPlanState, PLAN_SCHEMA_VERSION } from '../types/domain.ts';

export const PLAN_STORAGE_KEY = 'amisync_academic_plan';
export const MANUAL_REFRESH_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
export const AUTO_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Minimal subset of `chrome.storage.local`, injectable for deterministic unit testing in Node.
 */
export interface StorageAreaLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function resolveStorageArea(storage?: StorageAreaLike): StorageAreaLike {
  if (storage) {
    return storage;
  }
  const chromeStorage = (globalThis as { chrome?: { storage?: { local?: StorageAreaLike } } })
    .chrome?.storage?.local;
  if (!chromeStorage) {
    throw new Error('chrome.storage.local is unavailable in this environment.');
  }
  return chromeStorage;
}

/**
 * Loads the persisted `AcademicPlanState` from `chrome.storage.local`.
 * Falls back safely to a fresh default state if missing, corrupted, or schema-mismatched.
 */
export async function loadAcademicPlan(storage?: StorageAreaLike): Promise<AcademicPlanState> {
  const area = resolveStorageArea(storage);
  const result = await area.get(PLAN_STORAGE_KEY);
  const raw = result[PLAN_STORAGE_KEY];

  if (!raw) {
    return createDefaultAcademicPlanState();
  }

  try {
    const validated = validateAcademicPlanState(raw);
    if (validated.schemaVersion !== PLAN_SCHEMA_VERSION) {
      return createDefaultAcademicPlanState();
    }
    return validated;
  } catch {
    return createDefaultAcademicPlanState();
  }
}

/**
 * Persists the given `AcademicPlanState` under the versioned `chrome.storage.local` key.
 */
export async function saveAcademicPlan(
  plan: AcademicPlanState,
  storage?: StorageAreaLike
): Promise<void> {
  const area = resolveStorageArea(storage);
  const envelope: AcademicPlanState = {
    ...plan,
    schemaVersion: PLAN_SCHEMA_VERSION,
  };
  await area.set({ [PLAN_STORAGE_KEY]: envelope });
}

/**
 * Removes any persisted academic plan state from `chrome.storage.local`.
 */
export async function clearAcademicPlan(storage?: StorageAreaLike): Promise<void> {
  const area = resolveStorageArea(storage);
  await area.remove(PLAN_STORAGE_KEY);
}

/**
 * Checks whether the 30-minute manual refresh cooldown has elapsed since `lastRefreshTime`.
 */
export function canManualRefresh(
  lastRefreshTime: string | null,
  now: Date = new Date()
): { allowed: boolean; remainingMs: number } {
  if (!lastRefreshTime) {
    return { allowed: true, remainingMs: 0 };
  }

  const parsedMs = Date.parse(lastRefreshTime);
  if (!Number.isFinite(parsedMs)) {
    return { allowed: true, remainingMs: 0 };
  }

  const elapsedMs = now.getTime() - parsedMs;
  if (elapsedMs >= MANUAL_REFRESH_COOLDOWN_MS) {
    return { allowed: true, remainingMs: 0 };
  }

  return {
    allowed: false,
    remainingMs: Math.max(0, MANUAL_REFRESH_COOLDOWN_MS - elapsedMs),
  };
}

/**
 * Returns true if `lastRefreshTime` is absent, invalid, or at least 4 hours old.
 */
export function shouldAutoRefresh(
  lastRefreshTime: string | null,
  now: Date = new Date()
): boolean {
  if (!lastRefreshTime) {
    return true;
  }

  const parsedMs = Date.parse(lastRefreshTime);
  if (!Number.isFinite(parsedMs)) {
    return true;
  }

  return now.getTime() - parsedMs >= AUTO_REFRESH_INTERVAL_MS;
}
