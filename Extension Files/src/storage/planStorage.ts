import { validateAcademicPlanState } from '../amis/snapshot.ts';
import {
  DEFAULT_FALLBACK_TERMS,
  mergeTermOptions,
  shortenTermSemesterText,
} from '../amis/terms.ts';
import type { AcademicPlanState, AcademicTermOption } from '../types/domain.ts';
import { createDefaultAcademicPlanState, PLAN_SCHEMA_VERSION } from '../types/domain.ts';
import type { GeneratedScheduleAlternative } from '../types/solver.ts';

export const PLAN_STORAGE_KEY = 'amisync_academic_plan';
export const TERM_CATALOG_STORAGE_KEY = 'amisync_term_catalog';
export const COMPARE_HANDOFF_STORAGE_KEY = 'amisync_compare_handoff';
export const COMPARE_HANDOFF_TTL_MS = 60 * 1000; // 60 seconds
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

function isValidTermOption(value: unknown): value is AcademicTermOption {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.termId === 'number' &&
    Number.isInteger(obj.termId) &&
    obj.termId > 0 &&
    typeof obj.label === 'string' &&
    obj.label.trim().length > 0 &&
    typeof obj.shortLabel === 'string' &&
    obj.shortLabel.trim().length > 0 &&
    typeof obj.isMidyear === 'boolean' &&
    (obj.source === 'api' || obj.source === 'dom' || obj.source === 'fallback')
  );
}

/**
 * Loads the persisted term catalog from `chrome.storage.local`, merged with built-in fallback terms.
 * Self-heals corrupted payloads by removing the bad entry and returning `DEFAULT_FALLBACK_TERMS`.
 */
export async function loadTermCatalog(
  storage?: StorageAreaLike
): Promise<AcademicTermOption[]> {
  const area = resolveStorageArea(storage);
  const result = await area.get(TERM_CATALOG_STORAGE_KEY);
  const raw = result[TERM_CATALOG_STORAGE_KEY];

  if (!raw) {
    return [...DEFAULT_FALLBACK_TERMS];
  }

  if (!Array.isArray(raw) || !raw.every(isValidTermOption)) {
    await area.remove(TERM_CATALOG_STORAGE_KEY).catch(() => undefined);
    return [...DEFAULT_FALLBACK_TERMS];
  }

  const normalized = raw.map((term) => ({
    ...term,
    label: shortenTermSemesterText(term.label),
    shortLabel: shortenTermSemesterText(term.shortLabel),
  }));

  return mergeTermOptions(normalized, DEFAULT_FALLBACK_TERMS);
}

/**
 * Persists discovered academic terms to `chrome.storage.local` via the serialized write queue.
 */
export async function saveTermCatalog(
  terms: readonly AcademicTermOption[],
  storage?: StorageAreaLike
): Promise<void> {
  const area = resolveStorageArea(storage);
  const normalized = terms.map((term) => ({
    ...term,
    label: shortenTermSemesterText(term.label),
    shortLabel: shortenTermSemesterText(term.shortLabel),
  }));
  const sanitized = mergeTermOptions(normalized, DEFAULT_FALLBACK_TERMS);
  await enqueueStorageWrite(area, () => area.set({ [TERM_CATALOG_STORAGE_KEY]: sanitized }));
}

export interface CompareHandoffPayload {
  alternatives: GeneratedScheduleAlternative[];
  selectedPlanIndex: number;
  createdAtMs: number;
}

function isValidGeneratedAlternative(value: unknown): value is GeneratedScheduleAlternative {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.planLabel === 'string' &&
    typeof obj.profileTag === 'string' &&
    typeof obj.totalUnits === 'number' &&
    (obj.status === 'OPTIMAL' || obj.status === 'FEASIBLE') &&
    typeof obj.objectiveScoreZ === 'number' &&
    Array.isArray(obj.selectedSectionIds) &&
    obj.selectedSectionIds.every((id) => typeof id === 'string') &&
    Array.isArray(obj.hammingDistanceFromPrev) &&
    obj.hammingDistanceFromPrev.every((n) => typeof n === 'number')
  );
}

/**
 * Stores a short-lived one-shot handoff in `chrome.storage.local` so clicking
 * "Open Full Visual Compare in Overlay" from the popup immediately opens the
 * side-by-side visual comparison modal with the generated alternatives in the overlay.
 */
export async function saveCompareHandoff(
  alternatives: readonly GeneratedScheduleAlternative[],
  selectedPlanIndex: number,
  storage?: StorageAreaLike,
  nowMs: number = Date.now()
): Promise<void> {
  const area = resolveStorageArea(storage);
  const payload: CompareHandoffPayload = {
    alternatives: [...alternatives],
    selectedPlanIndex: Math.max(0, Math.min(Math.max(0, alternatives.length - 1), Math.trunc(selectedPlanIndex))),
    createdAtMs: nowMs,
  };
  await enqueueStorageWrite(area, () => area.set({ [COMPARE_HANDOFF_STORAGE_KEY]: payload }));
}

/**
 * Reads and immediately clears any fresh compare handoff written by the popup.
 */
export async function consumeCompareHandoff(
  storage?: StorageAreaLike,
  nowMs: number = Date.now()
): Promise<{ alternatives: GeneratedScheduleAlternative[]; selectedPlanIndex: number } | null> {
  const area = resolveStorageArea(storage);
  const result = await area.get(COMPARE_HANDOFF_STORAGE_KEY);
  const raw = result[COMPARE_HANDOFF_STORAGE_KEY];
  if (!raw) {
    return null;
  }

  await enqueueStorageWrite(area, () => area.remove(COMPARE_HANDOFF_STORAGE_KEY)).catch(
    () => undefined
  );

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  if (
    !Array.isArray(obj.alternatives) ||
    obj.alternatives.length < 2 ||
    !obj.alternatives.every(isValidGeneratedAlternative) ||
    typeof obj.selectedPlanIndex !== 'number' ||
    typeof obj.createdAtMs !== 'number'
  ) {
    return null;
  }

  if (nowMs - obj.createdAtMs > COMPARE_HANDOFF_TTL_MS || obj.createdAtMs - nowMs > COMPARE_HANDOFF_TTL_MS) {
    return null;
  }

  const clampedIndex = Math.max(
    0,
    Math.min(obj.alternatives.length - 1, Math.trunc(obj.selectedPlanIndex))
  );

  return {
    alternatives: obj.alternatives,
    selectedPlanIndex: clampedIndex,
  };
}
