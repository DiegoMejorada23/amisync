import { useEffect, useState } from 'react';
import { shortenTermSemesterText } from '../amis/index.ts';
import { checkExhaustedCapacity } from '../amis/parser.ts';
import type { RawAmisCourse } from '../types/amis.ts';
import type { AcademicTermOption, CourseEntry } from '../types/domain.ts';
import { normalizeCourseCode } from '../ui/planActions.ts';
import {
  formatSectionScheduleLines,
  getCapacityBadgeTone,
} from '../ui/scheduleView.ts';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  RefreshIcon,
  SearchIcon,
  StarIcon,
} from './Icons.tsx';

export type AmisConnectionStatus =
  | 'checking'
  | 'connected'
  | 'not_on_amis'
  | 'unauthenticated'
  | 'expired';

interface CoursesTabProps {
  intendedCourses: readonly CourseEntry[];
  preEnlistedCourses: readonly CourseEntry[];
  selectedTermId: number;
  availableTerms: readonly AcademicTermOption[];
  emptyTermSuggestion: AcademicTermOption | null;
  authStatus: AmisConnectionStatus;
  isOffline: boolean;
  statusMessage: string | null;
  searchError: string | null;
  isSyncing: boolean;
  isAddingCourse: boolean;
  isSolving: boolean;
  isSolveBlocked: boolean;
  canGenerate: boolean;
  onSelectTerm: (termId: number) => void;
  onSyncAmis: () => void;
  onSearchSuggestions: (query: string) => Promise<RawAmisCourse[]>;
  onAddCourseByCode: (courseCode: string) => Promise<boolean>;
  onRemoveCourse: (instanceId: string) => void;
  onToggleAccordion: (instanceId: string) => void;
  onToggleSectionFlag: (
    instanceId: string,
    sectionId: string,
    flag: 'isHidden' | 'isLocked' | 'isStarred'
  ) => void;
  onGenerateSchedules: () => void;
  onCancelSolve: () => void;
}

export function CoursesTab({
  intendedCourses,
  preEnlistedCourses,
  selectedTermId,
  availableTerms,
  emptyTermSuggestion,
  authStatus,
  isOffline,
  statusMessage,
  searchError,
  isSyncing,
  isAddingCourse,
  isSolving,
  isSolveBlocked,
  canGenerate,
  onSelectTerm,
  onSyncAmis,
  onSearchSuggestions,
  onAddCourseByCode,
  onRemoveCourse,
  onToggleAccordion,
  onToggleSectionFlag,
  onGenerateSchedules,
  onCancelSolve,
}: CoursesTabProps) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<RawAmisCourse[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const isConnected = authStatus === 'connected';

  useEffect(() => {
    const trimmed = query.trim();
    if (!isConnected || isOffline || trimmed.length < 2) {
      setSuggestions([]);
      setIsDropdownOpen(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void onSearchSuggestions(trimmed)
        .then((courses) => {
          if (cancelled) return;
          const uniqueByCode = new Map<string, RawAmisCourse>();
          for (const course of courses) {
            const key = normalizeCourseCode(course.course_code);
            if (!uniqueByCode.has(key)) {
              uniqueByCode.set(key, course);
            }
          }
          const list = Array.from(uniqueByCode.values()).slice(0, 8);
          setSuggestions(list);
          setIsDropdownOpen(list.length > 0);
        })
        .catch(() => {
          if (!cancelled) {
            setSuggestions([]);
            setIsDropdownOpen(false);
          }
        });
    }, 260);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, isConnected, onSearchSuggestions]);

  const handleSubmitCourse = async (targetCode: string) => {
    const trimmed = targetCode.trim();
    if (!trimmed || isAddingCourse) {
      return;
    }
    setIsDropdownOpen(false);
    const added = await onAddCourseByCode(trimmed);
    if (added) {
      setQuery('');
      setSuggestions([]);
    }
  };

  return (
    <div className="tab-panel">
      <div className="courses-panel__body">
        <div className="courses-panel__controls">
          {/* Search Header + Live AMIS Sync Bar */}
          <div className="search-header-row">
            <label className="section-overline" htmlFor="amisync-course-search">
              ADD DESIRED COURSES
            </label>
            <button
              type="button"
              className="sync-chip-btn"
              disabled={isSyncing || isOffline}
              onClick={onSyncAmis}
              title="Fetch active term, pre-enlisted courses, and latest section capacities from AMIS"
            >
              <RefreshIcon width={12} height={12} className={isSyncing ? 'spin-icon' : ''} />
              <span>{isSyncing ? 'Syncing...' : 'Sync AMIS'}</span>
            </button>
          </div>

          {/* Offline / Auth / Session Status Banners */}
          {isOffline && (
            <div className="amis-banner amis-banner--warn" role="status">
              <span className="amis-banner__text">
                Browser is offline. Live AMIS sync and course search are paused, while local CP-SAT
                optimization and QuickXplain diagnosis remain fully available.
              </span>
            </div>
          )}

          {!isOffline && authStatus !== 'connected' && (
            <div className="amis-banner amis-banner--warn" role="status">
              <span className="amis-banner__text">
                {authStatus === 'checking' && 'Checking active UPLB AMIS session...'}
                {authStatus === 'not_on_amis' &&
                  'Open an authenticated UPLB AMIS tab (amis.uplb.edu.ph) to fetch live courses.'}
                {authStatus === 'unauthenticated' &&
                  'You are not signed in to AMIS. Sign in on your active AMIS tab, then click Sync AMIS.'}
                {authStatus === 'expired' &&
                  'Your AMIS session expired (401/403). Refresh and sign in on AMIS, then click Sync AMIS.'}
              </span>
            </div>
          )}

          {statusMessage && (
            <div className="amis-banner amis-banner--info" role="status">
              <span className="amis-banner__text">{statusMessage}</span>
            </div>
          )}

          {/* Academic Term / Semester Selector */}
          <div className="term-selector-row">
            <label className="term-selector__label" htmlFor="amisync-term-select">
              ACADEMIC TERM
            </label>
            <select
              id="amisync-term-select"
              className="term-selector__select"
              value={selectedTermId}
              disabled={isSyncing || isAddingCourse}
              onChange={(e) => {
                const parsed = Number.parseInt(e.target.value, 10);
                if (Number.isInteger(parsed) && parsed > 0) {
                  onSelectTerm(parsed);
                }
              }}
            >
              {availableTerms.map((term) => (
                <option key={term.termId} value={term.termId}>
                  {shortenTermSemesterText(term.label)}
                </option>
              ))}
            </select>
          </div>

          {/* Search Box */}
          <form
            className="course-search-form"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmitCourse(query);
            }}
          >
            <div className="course-search-box">
              <SearchIcon width={15} height={15} className="course-search-box__icon" />
              <input
                id="amisync-course-search"
                type="text"
                className="course-search-box__input"
                placeholder={
                  isConnected
                    ? 'Type course code (e.g., CMSC 128) & press Enter'
                    : 'Course code search (requires active AMIS tab)'
                }
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && isDropdownOpen) {
                    e.stopPropagation();
                    setIsDropdownOpen(false);
                  }
                }}
                aria-autocomplete="list"
                aria-expanded={isDropdownOpen}
              />
              {isAddingCourse && <span className="search-inline-spinner" aria-label="Loading course" />}
            </div>

            {isDropdownOpen && suggestions.length > 0 && (
              <ul className="course-autocomplete" role="listbox">
                {suggestions.map((item) => (
                  <li key={`${item.course_id}-${item.course_code}`}>
                    <button
                      type="button"
                      className="course-autocomplete__item"
                      onClick={() => void handleSubmitCourse(item.course_code)}
                    >
                      <span className="course-autocomplete__code">{item.course_code}</span>
                      <span className="course-autocomplete__units">{item.units} units</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </form>

          {searchError && (
            <div className="amis-banner amis-banner--error amis-banner--with-action" role="alert">
              <span className="amis-banner__text">{searchError}</span>
              {emptyTermSuggestion && (
                <button
                  type="button"
                  className="amis-banner__action-btn"
                  disabled={isSyncing || isAddingCourse}
                  onClick={() => onSelectTerm(emptyTermSuggestion.termId)}
                >
                  Switch to {emptyTermSuggestion.termId}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Expandable Intended Course Accordions (scrolls internally only if needed) */}
        <div className="courses-list">
          {intendedCourses.length === 0 && (
            <div className="empty-courses-hint">
              {preEnlistedCourses.length > 0
                ? `${preEnlistedCourses.length} pre-enlisted course(s) locked on your timetable. Search above to add intended courses.`
                : 'No intended courses added yet. Search an AMIS course code above (e.g., CMSC 128, STAT 1) or click Sync AMIS.'}
            </div>
          )}

          {intendedCourses.map((course) => {
            const sectionCount = course.sections.length;
            const sectionWord = sectionCount === 1 ? 'Section' : 'Sections';
            const unitsLabel = Number.isInteger(course.units)
              ? `${course.units}`
              : `${Number(course.units.toFixed(1))}`;
            const unitWord = course.units === 1 ? 'unit' : 'units';
            const isExhausted = checkExhaustedCapacity(course).exhausted;

            return (
              <article key={course.instanceId} className="course-card">
                <div className="course-card__header">
                  <button
                    type="button"
                    className="course-card__toggle"
                    aria-expanded={course.isExpanded}
                    onClick={() => onToggleAccordion(course.instanceId)}
                  >
                    <span className="course-card__chevron">
                      {course.isExpanded ? (
                        <ChevronDownIcon width={14} height={14} />
                      ) : (
                        <ChevronRightIcon width={14} height={14} />
                      )}
                    </span>
                    <span className="course-card__code">{course.code}</span>
                    {isExhausted && (
                      <span
                        className="course-card__exhausted-pill"
                        title="0 open non-TBA sections available"
                      >
                        0 open
                      </span>
                    )}
                    <span className="course-card__meta-pill">
                      {unitsLabel} {unitWord} &bull; {sectionCount} {sectionWord}
                    </span>
                  </button>

                  <button
                    type="button"
                    className="course-card__remove"
                    aria-label={`Remove ${course.code}`}
                    title={`Drop ${course.code}`}
                    onClick={() => onRemoveCourse(course.instanceId)}
                  >
                    <CloseIcon width={12} height={12} />
                  </button>
                </div>

                {course.isExpanded && (
                  <div className="course-card__sections">
                    {course.sections.length === 0 ? (
                      <div className="section-empty-note">
                        No active sections found for term {selectedTermId}.
                      </div>
                    ) : (
                      course.sections.map((option) => {
                        const sec = option.section;
                        const tone = getCapacityBadgeTone(sec.activeClassSize, sec.maxClassSize);
                        const scheduleLines = formatSectionScheduleLines(sec);

                        return (
                          <div
                            key={sec.id}
                            className={`section-card ${
                              option.flags.isHidden ? 'section-card--hidden' : ''
                            } ${option.flags.isLocked ? 'section-card--locked' : ''}`}
                          >
                            <div className="section-card__main">
                              <div className="section-card__top">
                                <span className="section-card__name">SEC {sec.section}</span>
                                <span className={`capacity-ratio capacity-ratio--${tone}`}>
                                  {sec.activeClassSize}/{sec.maxClassSize}
                                </span>
                                {option.isPreEnlisted && (
                                  <span className="section-tag-locked">Pre-enlisted</span>
                                )}
                              </div>

                              <div className="section-card__lines">
                                {scheduleLines.map((line, i) => (
                                  <div key={`${sec.id}-line-${i}`} className="section-card__line">
                                    {line}
                                  </div>
                                ))}
                              </div>
                            </div>

                            <div className="section-card__controls">
                              <button
                                type="button"
                                className={`icon-toggle-btn ${
                                  option.flags.isHidden ? 'icon-toggle-btn--active-hide' : ''
                                }`}
                                aria-label={
                                  option.flags.isHidden
                                    ? `Unhide section ${sec.section}`
                                    : `Hide section ${sec.section}`
                                }
                                aria-pressed={option.flags.isHidden}
                                title={
                                  option.flags.isHidden
                                    ? 'Hidden (excluded from solver) — click to unhide'
                                    : 'Hide section (exclude from solver)'
                                }
                                onClick={() =>
                                  onToggleSectionFlag(course.instanceId, sec.id, 'isHidden')
                                }
                              >
                                {option.flags.isHidden ? (
                                  <EyeOffIcon width={15} height={15} />
                                ) : (
                                  <EyeIcon width={15} height={15} />
                                )}
                              </button>

                              <button
                                type="button"
                                className={`icon-toggle-btn ${
                                  option.flags.isLocked ? 'icon-toggle-btn--active-lock' : ''
                                }`}
                                aria-label={
                                  option.flags.isLocked
                                    ? `Unlock section ${sec.section}`
                                    : `Lock section ${sec.section}`
                                }
                                aria-pressed={option.flags.isLocked}
                                title={
                                  option.flags.isLocked
                                    ? 'Locked section (forced into schedule) — click to unlock'
                                    : 'Lock this section'
                                }
                                onClick={() =>
                                  onToggleSectionFlag(course.instanceId, sec.id, 'isLocked')
                                }
                              >
                                <LockIcon width={15} height={15} />
                              </button>

                              <button
                                type="button"
                                className={`icon-toggle-btn ${
                                  option.flags.isStarred ? 'icon-toggle-btn--active-star' : ''
                                }`}
                                aria-label={
                                  option.flags.isStarred
                                    ? `Unstar section ${sec.section}`
                                    : `Star section ${sec.section}`
                                }
                                aria-pressed={option.flags.isStarred}
                                title={
                                  option.flags.isStarred
                                    ? 'Starred (prioritized in objective) — click to unstar'
                                    : 'Star to prioritize this section'
                                }
                                onClick={() =>
                                  onToggleSectionFlag(course.instanceId, sec.id, 'isStarred')
                                }
                              >
                                <StarIcon width={15} height={15} filled={option.flags.isStarred} />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>

      {/* Pinned Bottom Action Area */}
      <div className="tab-panel__footer tab-panel__footer--stacked">
        {isSolving ? (
          <div className="solve-cta-row">
            <button type="button" className="btn-cta-primary btn-cta-primary--solving" disabled>
              SOLVING SCHEDULE...
            </button>
            <button type="button" className="btn-cancel-solve" onClick={onCancelSolve}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn-cta-primary"
            disabled={!canGenerate || isSolveBlocked}
            onClick={onGenerateSchedules}
          >
            GENERATE FEASIBLE SCHEDULES
          </button>
        )}
        <div className="cta-subcaption">Includes pre-enlisted courses</div>
      </div>
    </div>
  );
}
