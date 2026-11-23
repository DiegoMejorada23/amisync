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

export interface StorageChangeEntry {
  oldValue?: unknown;
  newValue?: unknown;
}

export interface StorageOnChangedLike {
  addListener(
    listener: (changes: Record<string, StorageChangeEntry>, areaName: string) => void
  ): void;
  removeListener(
    listener: (changes: Record<string, StorageChangeEntry>, areaName: string) => void
  ): void;
}

const writeQueueByStorage = new WeakMap<StorageAreaLike, Promise<void>>();

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

function enqueueStorageWrite(area: StorageAreaLike, task: () => Promise<void>): Promise<void> {
  const previous = writeQueueByStorage.get(area) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const tracked = next.catch(() => undefined);
  writeQueueByStorage.set(area, tracked);
  return next;
}

/**
 * Loads the persisted `AcademicPlanState` from `chrome.storage.local`.
 * Self-heals corrupted or schema-mismatched entries by removing them and falling back to defaults.
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
      await area.remove(PLAN_STORAGE_KEY).catch(() => undefined);
      return createDefaultAcademicPlanState();
    }
    return validated;
  } catch {
    await area.remove(PLAN_STORAGE_KEY).catch(() => undefined);
    return createDefaultAcademicPlanState();
  }
}

/**
 * Persists the given `AcademicPlanState` under the versioned `chrome.storage.local` key
 * using a per-storage serialized write queue so rapid edits never overwrite newer state.
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
  await enqueueStorageWrite(area, () => area.set({ [PLAN_STORAGE_KEY]: envelope }));
}

/**
 * Removes any persisted academic plan state from `chrome.storage.local`.
 */
export async function clearAcademicPlan(storage?: StorageAreaLike): Promise<void> {
  const area = resolveStorageArea(storage);
  await enqueueStorageWrite(area, () => area.remove(PLAN_STORAGE_KEY));
}

/**
 * Subscribes to external `chrome.storage.local` updates to keep popup, side-panel,
 * and overlay views synchronized without accepting corrupted payloads.
 */
export function subscribeAcademicPlanChanges(
  onPlanChange: (plan: AcademicPlanState) => void,
  storageOnChanged?: StorageOnChangedLike
): () => void {
  const events =
    storageOnChanged ??
    (globalThis as { chrome?: { storage?: { onChanged?: StorageOnChangedLike } } }).chrome?.storage
      ?.onChanged;

  if (!events?.addListener || !events?.removeListener) {
    return () => undefined;
  }

  const listener = (changes: Record<string, StorageChangeEntry>, areaName: string) => {
    if (areaName !== 'local') {
      return;
    }
    const change = changes[PLAN_STORAGE_KEY];
    if (!change) {
      return;
    }
    if (change.newValue === undefined || change.newValue === null) {
      onPlanChange(createDefaultAcademicPlanState());
      return;
    }
    try {
      const validated = validateAcademicPlanState(change.newValue);
      if (validated.schemaVersion === PLAN_SCHEMA_VERSION) {
        onPlanChange(validated);
      }
    } catch {
      // Ignore malformed storage writes from external sources.
    }
  };

  events.addListener(listener);
  return () => {
    events.removeListener(listener);
  };
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
