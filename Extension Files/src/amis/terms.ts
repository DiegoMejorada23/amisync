import type { RawAmisTerm } from '../types/amis.ts';
import type { AcademicTermOption } from '../types/domain.ts';

export const DEFAULT_FALLBACK_TERM_ID = 1261;

const FALLBACK_TERM_IDS = [1272, 1271, 1263, 1262, 1261, 1253, 1252, 1251] as const;

const SOURCE_PRIORITY: Record<AcademicTermOption['source'], number> = {
  api: 3,
  dom: 2,
  fallback: 1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFiniteTermId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{3,5}$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }
  }
  return null;
}

/**
 * Shortens verbose semester phrases (e.g., "First Semester", "Second Semester")
 * into compact "1st Sem" / "2nd Sem" forms to prevent dropdown truncation.
 */
export function shortenTermSemesterText(text: string): string {
  return text
    .replace(/\bFirst\s+Semester\b/gi, '1st Sem')
    .replace(/\bSecond\s+Semester\b/gi, '2nd Sem')
    .replace(/\b1st\s+Semester\b/gi, '1st Sem')
    .replace(/\b2nd\s+Semester\b/gi, '2nd Sem');
}

/**
 * Decodes standard 4-digit UP SAIS/AMIS term codes `1YY[1-3]`:
 * - `1` -> 1st Sem
 * - `2` -> 2nd Sem
 * - `3` -> Midyear
 * Example: `1261` -> `1st Sem (2026-2027)`.
 */
export function parseUplbTermCode(termId: number): {
  shortLabel: string;
  isMidyear: boolean;
} | null {
  if (!Number.isInteger(termId)) {
    return null;
  }
  const str = String(termId);
  const match = str.match(/^1(\d{2})([123])$/);
  if (!match) {
    return null;
  }

  const startYear = 2000 + Number.parseInt(match[1], 10);
  const endYear = startYear + 1;
  const semDigit = match[2];

  if (semDigit === '1') {
    return {
      shortLabel: `1st Sem (${startYear}-${endYear})`,
      isMidyear: false,
    };
  }
  if (semDigit === '2') {
    return {
      shortLabel: `2nd Sem (${startYear}-${endYear})`,
      isMidyear: false,
    };
  }
  return {
    shortLabel: `Midyear (${startYear}-${endYear})`,
    isMidyear: true,
  };
}

function cleanRawTermName(termId: number, rawName?: string): string {
  if (typeof rawName !== 'string') {
    return '';
  }
  const collapsed = rawName.trim().replace(/\s+/g, ' ');
  if (!collapsed) {
    return '';
  }
  const prefixRegex = new RegExp(`^${termId}\\s*[-–:|]\\s*`);
  const withoutPrefix = collapsed.replace(prefixRegex, '').trim();
  if (/^\d+$/.test(withoutPrefix) && Number(withoutPrefix) === termId) {
    return '';
  }
  return shortenTermSemesterText(withoutPrefix);
}

/**
 * Formats a normalized UPLB AMIS term label (`"${termId} - ${shortLabel}"`),
 * deduplicating any leading term ID prefix in `rawName` and falling back to
 * `parseUplbTermCode` or `"Term ${termId}"`.
 */
export function formatUplbTermLabel(
  termId: number,
  rawName?: string
): { label: string; shortLabel: string; isMidyear: boolean } {
  const cleaned = cleanRawTermName(termId, rawName);
  const decoded = parseUplbTermCode(termId);

  if (cleaned) {
    const isMidyear = /midyear|summer/i.test(cleaned) || Boolean(decoded?.isMidyear);
    return {
      label: `${termId} - ${cleaned}`,
      shortLabel: cleaned,
      isMidyear,
    };
  }

  if (decoded) {
    return {
      label: `${termId} - ${decoded.shortLabel}`,
      shortLabel: decoded.shortLabel,
      isMidyear: decoded.isMidyear,
    };
  }

  const fallbackShort = `Term ${termId}`;
  return {
    label: `${termId} - ${fallbackShort}`,
    shortLabel: fallbackShort,
    isMidyear: false,
  };
}

/**
 * Built-in fallback list of UPLB AMIS term codes when opening the extension
 * before loading the live AMIS Enrollment Term dropdown or API.
 */
export const DEFAULT_FALLBACK_TERMS: readonly AcademicTermOption[] = FALLBACK_TERM_IDS.map(
  (termId) => {
    const formatted = formatUplbTermLabel(termId);
    return {
      termId,
      label: formatted.label,
      shortLabel: formatted.shortLabel,
      isMidyear: formatted.isMidyear,
      source: 'fallback',
    };
  }
);

function buildRawTermLabelText(raw: RawAmisTerm): string | undefined {
  const direct =
    raw.label ??
    raw.name ??
    raw.description ??
    raw.term_name;
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct.trim();
  }
  const sem = typeof raw.semester === 'string' ? raw.semester.trim() : '';
  const ay = typeof raw.academic_year === 'string' ? raw.academic_year.trim() : '';
  if (sem && ay) {
    return `${sem} (${ay})`;
  }
  return sem || ay || undefined;
}

/**
 * Parses an unknown AMIS terms API payload (`{ terms: [...] }`, `{ terms: { data: [...] } }`,
 * `{ data: [...] }`, or plain array) into normalized `AcademicTermOption[]`.
 */
export function parseRawTermsPayload(body: unknown): AcademicTermOption[] {
  let rawItems: unknown[] | null = null;

  if (Array.isArray(body)) {
    rawItems = body;
  } else if (isRecord(body)) {
    if (Array.isArray(body.terms)) {
      rawItems = body.terms;
    } else if (isRecord(body.terms) && Array.isArray(body.terms.data)) {
      rawItems = body.terms.data;
    } else if (Array.isArray(body.data)) {
      rawItems = body.data;
    }
  }

  if (!rawItems) {
    return [];
  }

  const parsed: AcademicTermOption[] = [];
  for (const item of rawItems) {
    if (!isRecord(item)) {
      continue;
    }
    const raw = item as RawAmisTerm;
    const termId =
      parseFiniteTermId(raw.term_id) ??
      parseFiniteTermId(raw.id) ??
      parseFiniteTermId(raw.term_code) ??
      parseFiniteTermId(raw.code);

    if (termId === null) {
      continue;
    }

    const formatted = formatUplbTermLabel(termId, buildRawTermLabelText(raw));
    parsed.push({
      termId,
      label: formatted.label,
      shortLabel: formatted.shortLabel,
      isMidyear: formatted.isMidyear,
      source: 'api',
    });
  }

  return mergeTermOptions(parsed);
}

/**
 * Parses raw `<select>` `<option>` / custom dropdown entries extracted from the
 * active AMIS Enrollment page's `Term *` dropdown into `AcademicTermOption[]`.
 */
export function parseTermDropdownEntries(
  entries: ReadonlyArray<{ value?: string; text?: string; selected?: boolean }>
): { terms: AcademicTermOption[]; selectedTermId: number | null } {
  const parsed: AcademicTermOption[] = [];
  let selectedTermId: number | null = null;

  for (const entry of entries) {
    const rawValue = typeof entry.value === 'string' ? entry.value.trim() : '';
    const rawText = typeof entry.text === 'string' ? entry.text.trim().replace(/\s+/g, ' ') : '';

    if (/^(select|choose|--)/i.test(rawText) && !/^\d{3,5}$/.test(rawValue)) {
      continue;
    }

    let termId = parseFiniteTermId(rawValue);
    if (termId === null && rawText) {
      const textIdMatch = rawText.match(/^\s*(\d{3,5})(?:\b|\s*[-–:|])/);
      if (textIdMatch?.[1]) {
        termId = parseFiniteTermId(textIdMatch[1]);
      }
    }

    if (termId === null) {
      continue;
    }

    const formatted = formatUplbTermLabel(termId, rawText || undefined);
    parsed.push({
      termId,
      label: formatted.label,
      shortLabel: formatted.shortLabel,
      isMidyear: formatted.isMidyear,
      source: 'dom',
    });

    if (entry.selected && selectedTermId === null) {
      selectedTermId = termId;
    }
  }

  return {
    terms: mergeTermOptions(parsed),
    selectedTermId,
  };
}

function isBareTermLabel(option: AcademicTermOption): boolean {
  return option.shortLabel === `Term ${option.termId}`;
}

/**
 * Deduplicates term lists by `termId`, preferring higher-priority sources (`api` > `dom` > `fallback`)
 * unless an existing entry has only a bare `"Term N"` label and another provides a decoded semester label.
 * Results are sorted descending by `termId`.
 */
export function mergeTermOptions(
  ...lists: ReadonlyArray<ReadonlyArray<AcademicTermOption>>
): AcademicTermOption[] {
  const byId = new Map<number, AcademicTermOption>();

  for (const list of lists) {
    for (const candidate of list) {
      if (!Number.isInteger(candidate.termId) || candidate.termId <= 0) {
        continue;
      }
      const existing = byId.get(candidate.termId);
      if (!existing) {
        byId.set(candidate.termId, candidate);
        continue;
      }

      const existingBare = isBareTermLabel(existing);
      const candidateBare = isBareTermLabel(candidate);

      if (existingBare && !candidateBare) {
        byId.set(candidate.termId, candidate);
        continue;
      }
      if (!existingBare && candidateBare) {
        continue;
      }

      const existingPri = SOURCE_PRIORITY[existing.source];
      const candidatePri = SOURCE_PRIORITY[candidate.source];
      if (candidatePri > existingPri) {
        byId.set(candidate.termId, candidate);
      } else if (
        candidatePri === existingPri &&
        candidate.shortLabel.length > existing.shortLabel.length
      ) {
        byId.set(candidate.termId, candidate);
      }
    }
  }

  return Array.from(byId.values()).sort((a, b) => b.termId - a.termId);
}

/**
 * Suggests an alternative term when the selected term has 0 classes published:
 * prefers the highest regular (non-midyear) term with `termId < currentTermId`
 * (e.g., `1262` -> `1261`), falling back to any lower term, then any other available term.
 */
export function suggestAlternativeTerm(
  currentTermId: number,
  availableTerms: readonly AcademicTermOption[]
): AcademicTermOption | null {
  const sortedOthers = availableTerms
    .filter((t) => t.termId !== currentTermId)
    .sort((a, b) => b.termId - a.termId);

  if (sortedOthers.length === 0) {
    return null;
  }

  const lowerRegular = sortedOthers.find((t) => t.termId < currentTermId && !t.isMidyear);
  if (lowerRegular) {
    return lowerRegular;
  }

  const lowerAny = sortedOthers.find((t) => t.termId < currentTermId);
  if (lowerAny) {
    return lowerAny;
  }

  return sortedOthers[0] ?? null;
}

/**
 * Formats a clear empty-state message when `classes.total === 0` (`classes.data` is empty)
 * for the selected term, including an actionable switch suggestion (e.g., `1262` -> `1261`).
 */
export function formatEmptyTermClassesMessage(
  courseCode: string,
  termId: number,
  availableTerms: readonly AcademicTermOption[]
): { message: string; suggestedTerm: AcademicTermOption | null } {
  const suggestedTerm = suggestAlternativeTerm(termId, availableTerms);
  const code = courseCode.trim();

  if (suggestedTerm) {
    return {
      message: `No sections published yet for ${code} in ${termId} — try switching to ${suggestedTerm.termId} (${suggestedTerm.shortLabel}).`,
      suggestedTerm,
    };
  }

  return {
    message: `No sections published yet for ${code} in term ${termId}.`,
    suggestedTerm: null,
  };
}
