import { useEffect, useMemo, useRef } from 'react';
import type { AcademicPlanState, Weekday } from '../types/domain.ts';
import type { GeneratedScheduleAlternative } from '../types/solver.ts';
import {
  buildPlanComparisonCards,
  type PlanComparisonCardModel,
} from '../ui/planComparison.ts';
import {
  GRID_DAY_HEADERS_SHORT,
  GRID_DAYS,
  GRID_HOURS,
  isSlotBlocked,
  type TimetableBlock,
} from '../ui/scheduleView.ts';
import { CloseIcon, LockIcon, StarIcon } from './Icons.tsx';

export interface PlanComparisonModalProps {
  isOpen: boolean;
  isCompactPopup: boolean;
  canExpandOverlay: boolean;
  plan: AcademicPlanState;
  alternatives: readonly GeneratedScheduleAlternative[];
  selectedPlanIndex: number;
  onSelectPlan: (index: number) => void;
  onClose: () => void;
  onOpenOverlayCompare?: () => void;
}

function MiniTimetableGrid({
  plan,
  blocks,
  planLabel,
}: {
  plan: AcademicPlanState;
  blocks: readonly TimetableBlock[];
  planLabel: string;
}) {
  const blocksByDay = useMemo(() => {
    const map = new Map<Weekday, TimetableBlock[]>();
    for (const day of GRID_DAYS) {
      map.set(day, []);
    }
    for (const block of blocks) {
      map.get(block.day)?.push(block);
    }
    return map;
  }, [blocks]);

  return (
    <div
      className="mini-timetable"
      role="img"
      aria-label={`${planLabel} weekly schedule preview from Monday to Saturday, 7 AM to 7 PM`}
    >
      <div className="mini-timetable__grid">
        <div className="mini-timetable__header mini-timetable__header--time">TIME</div>
        {GRID_DAYS.map((day) => (
          <div key={day} className="mini-timetable__header">
            {GRID_DAY_HEADERS_SHORT[day]}
          </div>
        ))}

        <div className="mini-timetable__time-col" aria-hidden="true">
          {GRID_HOURS.map((hour) => (
            <div key={hour.startMinutes} className="mini-timetable__time-cell">
              {hour.label}
            </div>
          ))}
        </div>

        {GRID_DAYS.map((day) => {
          const dayBlocks = blocksByDay.get(day) ?? [];
          return (
            <div key={day} className="mini-timetable__day-col">
              {GRID_HOURS.map((hour) => {
                const blocked = isSlotBlocked(plan, day, hour.startMinutes, hour.endMinutes);
                return (
                  <div
                    key={`${day}-${hour.startMinutes}`}
                    className={`mini-timetable__slot ${
                      blocked ? 'mini-timetable__slot--blocked' : ''
                    }`}
                  />
                );
              })}

              <div className="mini-timetable__blocks-layer">
                {dayBlocks.map((block) => (
                  <div
                    key={block.key}
                    className={`mini-timetable__block ${
                      block.isLocked
                        ? 'timetable-block--locked'
                        : `timetable-block--color-${block.colorIndex}`
                    }`}
                    style={{
                      top: `${block.topPercent}%`,
                      height: `${block.heightPercent}%`,
                    }}
                    title={`${block.title} (${block.timeRangeLabel})${
                      block.location ? ` • ${block.location}` : ''
                    }`}
                  >
                    <span className="mini-timetable__block-label">{block.courseCode}</span>
                    <span className="mini-timetable__block-section">
                      SEC {block.sectionName}
                    </span>
                    {block.location && block.heightPercent >= 16 && (
                      <span className="mini-timetable__block-room">{block.location}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlanComparisonCard({
  card,
  plan,
  isSelected,
  isCompactPopup,
  onSelectPlan,
}: {
  card: PlanComparisonCardModel;
  plan: AcademicPlanState;
  isSelected: boolean;
  isCompactPopup: boolean;
  onSelectPlan: (index: number) => void;
}) {
  return (
    <article
      className={`compare-card ${card.index === 0 ? 'compare-card--recommended' : ''} ${
        isSelected ? 'compare-card--active' : ''
      }`}
      aria-label={`${card.planLabel} comparison card`}
    >
      <header className="compare-card__header">
        <div className="compare-card__header-main">
          <span
            className={`compare-card__badge ${
              card.index === 0 ? 'compare-card__badge--recommended' : ''
            }`}
          >
            {card.headerBadge}
          </span>
          {card.index > 0 && (
            <span
              className={`compare-card__status-chip compare-card__status-chip--${
                card.alternative.status === 'OPTIMAL' ? 'optimal' : 'feasible'
              }`}
            >
              {card.statusLabel}
            </span>
          )}
          {isSelected && <span className="compare-card__active-chip">Current</span>}
        </div>
        <span className="compare-card__units">{card.totalUnitsLabel}</span>
      </header>

      {!isCompactPopup && (
        <MiniTimetableGrid plan={plan} blocks={card.blocks} planLabel={card.planLabel} />
      )}

      <div className="compare-card__metrics" aria-label={`${card.planLabel} schedule trade-offs`}>
        <div className="compare-metric">
          <span className="compare-metric__label">Idle Gaps</span>
          <strong className="compare-metric__value">{card.metrics.totalIdleGapLabel}</strong>
        </div>
        <div className="compare-metric">
          <span className="compare-metric__label">Class Hours</span>
          <strong className="compare-metric__value">{card.metrics.timeRangeLabel}</strong>
        </div>
        <div className="compare-metric">
          <span className="compare-metric__label">Preferred</span>
          <strong className="compare-metric__value">{card.metrics.starredLabel}</strong>
        </div>
        {isCompactPopup && (
          <div className="compare-metric">
            <span className="compare-metric__label">Active Days</span>
            <strong className="compare-metric__value">
              {card.metrics.activeDaysCount}d ({card.metrics.freeDaysCount} free)
            </strong>
          </div>
        )}
      </div>

      <div className="compare-card__courses" aria-label={`${card.planLabel} chosen sections`}>
        <div className="compare-card__courses-title">Chosen Sections</div>
        <ul className="compare-course-list">
          {card.courseSelections.map((item) => (
            <li key={item.key} className="compare-course-item">
              <div className="compare-course-item__primary">
                <span
                  className={`compare-course-swatch ${
                    item.isPreEnlisted
                      ? 'timetable-block--locked'
                      : `timetable-block--color-${item.colorIndex}`
                  }`}
                  aria-hidden="true"
                />
                <span className="compare-course-item__code">{item.courseCode}</span>
                <span
                  className="compare-course-item__section-pill"
                  title={`${item.courseCode} — ${item.sectionBadge}`}
                >
                  {item.sectionBadge}
                </span>
                {item.isPreEnlisted && (
                  <span className="compare-course-flag compare-course-flag--locked" title="Pre-enlisted">
                    <LockIcon width={10} height={10} />
                  </span>
                )}
                {item.isStarred && (
                  <span className="compare-course-flag compare-course-flag--starred" title="Starred section">
                    <StarIcon width={10} height={10} filled />
                  </span>
                )}
              </div>
              {item.scheduleSummary && (
                <span className="compare-course-item__schedule" title={item.scheduleSummary}>
                  {item.scheduleSummary}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <footer className="compare-card__footer">
        <button
          type="button"
          className="compare-card__select-btn"
          aria-label={`Select ${card.planLabel}`}
          onClick={() => onSelectPlan(card.index)}
        >
          Select Plan
        </button>
      </footer>
    </article>
  );
}

export function PlanComparisonModal({
  isOpen,
  isCompactPopup,
  canExpandOverlay,
  plan,
  alternatives,
  selectedPlanIndex,
  onSelectPlan,
  onClose,
  onOpenOverlayCompare,
}: PlanComparisonModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const cards = useMemo(
    () => buildPlanComparisonCards(plan, alternatives),
    [plan, alternatives]
  );

  useEffect(() => {
    if (isOpen) {
      dialogRef.current?.focus();
    }
  }, [isOpen]);

  if (!isOpen || cards.length < 2) {
    return null;
  }

  const gridColumnClass = cards.length === 2 ? 'grid-cols-2' : 'grid-cols-3';

  return (
    <div
      className={`compare-modal-backdrop ${
        isCompactPopup ? 'compare-modal-backdrop--popup' : 'compare-modal-backdrop--overlay'
      }`}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={`compare-modal ${
          isCompactPopup ? 'compare-modal--popup' : 'compare-modal--overlay'
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="amisync-compare-modal-title"
        tabIndex={-1}
      >
        <header className="compare-modal__header">
          <div className="compare-modal__title-group">
            <h2 id="amisync-compare-modal-title" className="compare-modal__title">
              Compare Generated Plans
            </h2>
            <span className="compare-modal__subtitle">
              {cards.length} feasible schedule{cards.length === 1 ? '' : 's'} • Pick one to apply
            </span>
          </div>
          <button
            type="button"
            className="compare-modal__close"
            aria-label="Close plan comparison"
            title="Close (Esc)"
            onClick={onClose}
          >
            <CloseIcon width={14} height={14} />
          </button>
        </header>

        <div className={`compare-modal__grid ${gridColumnClass}`}>
          {cards.map((card) => (
            <PlanComparisonCard
              key={`${card.planLabel}-${card.index}`}
              card={card}
              plan={plan}
              isSelected={card.index === selectedPlanIndex}
              isCompactPopup={isCompactPopup}
              onSelectPlan={onSelectPlan}
            />
          ))}
        </div>

        {isCompactPopup && (
          <footer className="compare-modal__popup-footer">
            <span className="compare-modal__popup-hint">
              Need visual timetables side-by-side?
            </span>
            <button
              type="button"
              className="compare-modal__overlay-btn"
              disabled={!canExpandOverlay}
              title={
                canExpandOverlay
                  ? 'Open full visual comparison in the AMIS page overlay'
                  : 'Open a logged-in UPLB AMIS tab to launch the full visual overlay'
              }
              onClick={() => onOpenOverlayCompare?.()}
            >
              Open Full Visual Compare in Overlay
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
