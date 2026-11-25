import type { AcademicTermOption } from '../types/domain.ts';
import { AmisError } from './errors.ts';
import { parseTermDropdownEntries } from './terms.ts';

/**
 * URL pattern matching UP AMIS portals (e.g., https://amis.uplb.edu.ph/*).
 */
export const AMIS_URL_REGEX = /.*\/\/amis\.up.*\.edu\.ph.*/;

/**
 * Hostname extractor matching UP AMIS origins for API base derivation.
 */
export const AMIS_HOST_REGEX = /https?:\/\/(amis\.up.*\.edu\.ph)/;

export interface ActiveTabSummary {
  id: number;
  url: string;
}

/**
 * Minimal subset of the Chrome Extensions API used by the AMIS portal bridge,
 * injectable for deterministic unit testing in Node.
 */
export interface ChromeBridgeApi {
  tabs: {
    query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number; url?: string }>>;
    onActivated: {
      addListener(listener: (activeInfo: { tabId: number; windowId: number }) => void): void;
      removeListener(listener: (activeInfo: { tabId: number; windowId: number }) => void): void;
    };
    onUpdated?: {
      addListener(
        listener: (tabId: number, changeInfo: { status?: string; url?: string }) => void
      ): void;
      removeListener(
        listener: (tabId: number, changeInfo: { status?: string; url?: string }) => void
      ): void;
    };
  };
  scripting: {
    executeScript<TArgs extends unknown[], TResult>(injection: {
      target: { tabId: number };
      func: (...args: TArgs) => TResult | Promise<TResult>;
      args?: TArgs;
    }): Promise<Array<{ result?: TResult }>>;
  };
}

function resolveChromeBridgeApi(chromeApi?: ChromeBridgeApi): ChromeBridgeApi {
  const api = chromeApi ?? (globalThis as { chrome?: ChromeBridgeApi }).chrome;
  if (!api?.tabs?.query || !api?.scripting?.executeScript) {
    throw new AmisError(
      'NOT_ON_AMIS_TAB',
      'Chrome tabs/scripting APIs are unavailable outside the extension context.'
    );
  }
  return api;
}

/**
 * Returns true if the given URL belongs to a UP AMIS portal.
 */
export function isAmisUrl(url: string | undefined): boolean {
  return typeof url === 'string' && AMIS_URL_REGEX.test(url);
}

/**
 * Derives the origin-matched AMIS REST API base URL from a portal page href.
 * Example: "https://amis.uplb.edu.ph/..." -> "https://api-amis.uplb.edu.ph"
 */
export function deriveApiBaseFromHref(href: string): string {
  const match = href.match(AMIS_HOST_REGEX);
  if (!match?.[1]) {
    throw new AmisError(
      'NOT_ON_AMIS_TAB',
      'Script must be run on an AMIS website (amis.up*.edu.ph).'
    );
  }
  return `https://api-${match[1]}`;
}

/**
 * Extracts and URI-decodes the Nuxt Auth `auth._token.local` cookie verbatim.
 * Preserves the full Authorization header value (including any `=` characters in JWTs).
 */
export function extractAuthTokenFromCookieString(cookieString: string): string | null {
  if (!cookieString) {
    return null;
  }

  const entries = cookieString.split(/;\s*/);
  const tokenEntry = entries.find((entry) => entry.startsWith('auth._token.local='));
  if (!tokenEntry) {
    return null;
  }

  const eqIndex = tokenEntry.indexOf('=');
  const raw = eqIndex >= 0 ? tokenEntry.slice(eqIndex + 1) : '';
  if (!raw || raw === 'false') {
    return null;
  }

  try {
    return decodeURI(raw);
  } catch {
    return null;
  }
}

/**
 * Queries the active tab in the current window and returns it only if it matches AMIS_URL_REGEX.
 */
export async function getActiveAmisTab(chromeApi?: ChromeBridgeApi): Promise<ActiveTabSummary | null> {
  const api = resolveChromeBridgeApi(chromeApi);
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];

  if (typeof activeTab?.id !== 'number' || !isAmisUrl(activeTab.url)) {
    return null;
  }

  return {
    id: activeTab.id,
    url: activeTab.url as string,
  };
}

/**
 * Executes a self-contained function inside the currently active AMIS tab.
 * Throws AmisError('NOT_ON_AMIS_TAB') if the active tab is not an AMIS portal.
 */
export async function executeInActiveAmisTab<TArgs extends unknown[], TResult>(
  func: (...args: TArgs) => TResult | Promise<TResult>,
  args: TArgs,
  chromeApi?: ChromeBridgeApi
): Promise<TResult> {
  const api = resolveChromeBridgeApi(chromeApi);
  const amisTab = await getActiveAmisTab(api);

  if (!amisTab) {
    throw new AmisError(
      'NOT_ON_AMIS_TAB',
      'You are not on an active UPLB AMIS tab. Open https://amis.uplb.edu.ph/ and sign in.'
    );
  }

  const results = await api.scripting.executeScript({
    target: { tabId: amisTab.id },
    func,
    args,
  });

  if (!results || results.length === 0) {
    throw new AmisError('MALFORMED_RESPONSE', 'Active tab script execution returned no result.');
  }

  return results[0].result as TResult;
}

/**
 * Reads `auth._token.local` from `document.cookie` on the active AMIS tab.
 * Returns `null` if not on an AMIS tab or if no valid token cookie is present.
 */
export async function getAuthToken(chromeApi?: ChromeBridgeApi): Promise<string | null> {
  const api = resolveChromeBridgeApi(chromeApi);
  const amisTab = await getActiveAmisTab(api);
  if (!amisTab) {
    return null;
  }

  try {
    const results = await api.scripting.executeScript({
      target: { tabId: amisTab.id },
      // Must remain completely self-contained for MV3 executeScript serialization.
      func: () => {
        const entry = document.cookie
          .split('; ')
          .find((item) => item.startsWith('auth._token.local='));
        if (!entry) {
          return null;
        }
        const eqIndex = entry.indexOf('=');
        const raw = eqIndex >= 0 ? entry.slice(eqIndex + 1) : '';
        if (!raw || raw === 'false') {
          return null;
        }
        try {
          return decodeURI(raw);
        } catch {
          return null;
        }
      },
    });

    return results[0]?.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Immediately synchronizes the AMIS auth token and subscribes to `chrome.tabs.onActivated`
 * so switching tabs keeps authentication state up to date. Returns an unsubscribe cleanup callback.
 */
export function subscribeAuthTokenSync(
  onTokenChange: (token: string | null) => void,
  chromeApi?: ChromeBridgeApi
): () => void {
  const api = resolveChromeBridgeApi(chromeApi);
  let disposed = false;

  const refresh = () => {
    void getAuthToken(api)
      .then((token) => {
        if (!disposed) {
          onTokenChange(token);
        }
      })
      .catch(() => {
        if (!disposed) {
          onTokenChange(null);
        }
      });
  };

  const handleActivated = () => {
    refresh();
  };

  const handleUpdated = (_tabId: number, changeInfo: { status?: string; url?: string }) => {
    if (changeInfo.status === 'complete' || typeof changeInfo.url === 'string') {
      refresh();
    }
  };

  refresh();
  api.tabs.onActivated.addListener(handleActivated);
  api.tabs.onUpdated?.addListener(handleUpdated);

  return () => {
    disposed = true;
    api.tabs.onActivated.removeListener(handleActivated);
    api.tabs.onUpdated?.removeListener(handleUpdated);
  };
}

/**
 * Performs read-only inspection of the active AMIS tab's Term dropdown (`<select>` or
 * custom listbox options) to discover live term IDs and labels.
 */
export async function extractTermsFromActiveAmisTab(
  chromeApi?: ChromeBridgeApi
): Promise<{ terms: AcademicTermOption[]; selectedTermId: number | null }> {
  const api = resolveChromeBridgeApi(chromeApi);
  const amisTab = await getActiveAmisTab(api);
  if (!amisTab) {
    return { terms: [], selectedTermId: null };
  }

  try {
    const results = await api.scripting.executeScript({
      target: { tabId: amisTab.id },
      // Must remain completely self-contained for MV3 executeScript serialization.
      func: (): Array<{ value: string; text: string; selected: boolean }> => {
        const collected: Array<{ value: string; text: string; selected: boolean }> = [];
        const selects = Array.from(document.querySelectorAll('select'));

        let bestSelect: HTMLSelectElement | null = null;
        let bestScore = 0;

        for (const select of selects) {
          const id = select.id ?? '';
          const name = select.getAttribute('name') ?? '';
          const ariaLabel = select.getAttribute('aria-label') ?? '';
          let labelText = '';
          if (id) {
            const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            labelText = labelEl?.textContent ?? '';
          }
          if (!labelText) {
            const parentLabel = select.closest('label');
            labelText = parentLabel?.textContent ?? '';
          }

          const metaText = `${id} ${name} ${ariaLabel} ${labelText}`.toLowerCase();
          const options = Array.from(select.options);
          const hasTermMeta = /\bterm\b|semester|academic/.test(metaText);
          const matchingOptionCount = options.filter((opt) => {
            const val = (opt.value ?? '').trim();
            const txt = (opt.textContent ?? '').trim();
            return (
              /^\d{3,5}$/.test(val) ||
              /\b1\d{3}\b/.test(txt) ||
              /semester|midyear/i.test(txt)
            );
          }).length;

          if (matchingOptionCount === 0 && !hasTermMeta) {
            continue;
          }

          const score = (hasTermMeta ? 100 : 0) + matchingOptionCount;
          if (score > bestScore && matchingOptionCount > 0) {
            bestScore = score;
            bestSelect = select;
          }
        }

        if (bestSelect) {
          for (const opt of Array.from(bestSelect.options)) {
            collected.push({
              value: (opt.value ?? '').trim(),
              text: (opt.textContent ?? '').trim(),
              selected: Boolean(opt.selected),
            });
          }
          return collected;
        }

        const customItems = Array.from(
          document.querySelectorAll(
            '[role="option"], [data-term-id], .v-list-item, .el-select-dropdown__item'
          )
        );
        for (const el of customItems) {
          const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
          const dataTermId = el.getAttribute('data-term-id') ?? '';
          const dataValue = el.getAttribute('data-value') ?? dataTermId;
          const matchesTerm =
            /^\d{3,5}$/.test(dataTermId.trim()) ||
            /\b1\d{3}\b.*(?:semester|midyear)/i.test(text) ||
            /^\s*1\d{3}\s*[-–]/.test(text);
          if (!matchesTerm) {
            continue;
          }
          const isSelected =
            el.getAttribute('aria-selected') === 'true' ||
            el.classList.contains('selected') ||
            el.classList.contains('is-selected');
          collected.push({
            value: dataValue.trim(),
            text,
            selected: isSelected,
          });
        }

        return collected;
      },
    });

    const rawEntries = results[0]?.result;
    if (!Array.isArray(rawEntries)) {
      return { terms: [], selectedTermId: null };
    }
    return parseTermDropdownEntries(rawEntries);
  } catch {
    return { terms: [], selectedTermId: null };
  }
}
