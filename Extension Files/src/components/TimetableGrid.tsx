import { useEffect, useMemo, useRef, useState } from 'react';
import type { AcademicPlanState, Weekday } from '../types/domain.ts';
import type { GeneratedScheduleAlternative } from '../types/solver.ts';
import {
  buildTimetableBlocks,
  GRID_DAY_HEADERS,
  GRID_DAY_HEADERS_SHORT,
  GRID_DAYS,
  GRID_HOURS,
  isCellLockedByPreEnlisted,
  isSlotBlocked,
  type BlockedCellCoordinate,
  type TimetableBlock,
} from '../ui/scheduleView.ts';
import {
  getDragPreviewCellKeys,
  TimetableDragController,
  type DragBlockMode,
  type GlobalEventTargetLike,
  type TimetableDragSession,
} from '../ui/timetableDrag.ts';

interface TimetableGridProps {
  plan: AcademicPlanState;
  activeAlternative: GeneratedScheduleAlternative | null;
  isSolving: boolean;
  isBlockingEnabled: boolean;
  useCompactDayHeaders?: boolean;
  onToggleCell: (day: Weekday, startMinutes: number) => void;
  onCommitBlockedRange: (
    cells: readonly BlockedCellCoordinate[],
    action: DragBlockMode
  ) => void;
}

export function TimetableGrid({
  plan,
  activeAlternative,
  isSolving,
  isBlockingEnabled,
  useCompactDayHeaders = false,
  onToggleCell,
  onCommitBlockedRange,
}: TimetableGridProps) {
  const [dragSession, setDragSession] = useState<TimetableDragSession | null>(null);

  const controllerRef = useRef<TimetableDragController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new TimetableDragController({
      isBlockingEnabled,
      onSessionChange: setDragSession,
      onCommitRange: onCommitBlockedRange,
      onToggleCell,
    });
  }

  controllerRef.current.updateOptions({
    isBlockingEnabled,
    onSessionChange: setDragSession,
    onCommitRange: onCommitBlockedRange,
    onToggleCell,
  });

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) {
      return;
    }
    const targets: GlobalEventTargetLike[] = [];
    if (typeof document !== 'undefined') {
      targets.push(document);
    }
    if (typeof window !== 'undefined') {
      targets.push(window);
    }
    if (targets.length === 0) {
      return;
    }
    return controller.attachGlobalListeners(targets);
  }, []);

  const blocks = buildTimetableBlocks(plan, activeAlternative);

  const blocksByDay = new Map<Weekday, TimetableBlock[]>();
  for (const day of GRID_DAYS) {
    blocksByDay.set(day, []);
  }
  for (const block of blocks) {
    blocksByDay.get(block.day)?.push(block);
  }

  const previewCellKeys = useMemo(
    () => (isBlockingEnabled ? getDragPreviewCellKeys(plan, dragSession) : new Set<string>()),
    [dragSession, isBlockingEnabled, plan]
  );

  const isDragging = isBlockingEnabled && dragSession !== null;

  const dayHeaders = useCompactDayHeaders ? GRID_DAY_HEADERS_SHORT : GRID_DAY_HEADERS;

  return (
    <div className="timetable-wrapper" aria-busy={isSolving}>
      <div
        className={`timetable-grid ${isBlockingEnabled ? 'timetable-grid--editable' : 'timetable-grid--readonly'} ${
          isDragging ? 'timetable-grid--dragging' : ''
        }`}
        role="grid"
        aria-label="Weekly schedule timetable"
      >
        {/* Header Row */}
        <div className="timetable-header timetable-header--time" role="columnheader">
          TIME
        </div>
        {GRID_DAYS.map((day) => (
          <div key={day} className="timetable-header" role="columnheader">
            {dayHeaders[day]}
          </div>
        ))}

        {/* Body Area: Left Time Labels + 6 Day Columns */}
        <div className="timetable-time-col" aria-hidden="true">
          {GRID_HOURS.map((hour) => (
            <div key={hour.startMinutes} className="timetable-time-cell">
              {hour.label}
            </div>
          ))}
        </div>

        {GRID_DAYS.map((day) => {
          const dayBlocks = blocksByDay.get(day) ?? [];
          return (
            <div key={day} className="timetable-day-col">
              {GRID_HOURS.map((hour) => {
                const blocked = isSlotBlocked(plan, day, hour.startMinutes, hour.endMinutes);
                const locked = isCellLockedByPreEnlisted(
                  plan,
                  day,
                  hour.startMinutes,
                  hour.endMinutes
                );
                const inPreview =
                  !locked &&
                  isBlockingEnabled &&
                  previewCellKeys.has(`${day}:${hour.startMinutes}`);
                const effectiveBlocked =
                  inPreview && dragSession ? dragSession.mode === 'block' : blocked;
                const slotDisabled = locked || !isBlockingEnabled;

                const ariaLabel = locked
                  ? `${day} ${hour.label}: Locked pre-enlisted class`
                  : !isBlockingEnabled
                    ? effectiveBlocked
                      ? `${day} ${hour.label}: Blocked.`
                      : `${day} ${hour.label}: Available.`
                    : effectiveBlocked
                      ? `${day} ${hour.label}: Blocked. Click or drag to unblock.`
                      : `${day} ${hour.label}: Available. Click or drag to block.`;

                return (
                  <button
                    key={`${day}-${hour.startMinutes}`}
                    type="button"
                    className={`timetable-slot ${
                      effectiveBlocked ? 'timetable-slot--blocked' : ''
                    } ${locked ? 'timetable-slot--locked-underlay' : ''} ${
                      !isBlockingEnabled ? 'timetable-slot--readonly' : ''
                    } ${inPreview ? 'timetable-slot--drag-target' : ''}`}
                    disabled={slotDisabled}
                    aria-pressed={effectiveBlocked}
                    aria-label={ariaLabel}
                    onPointerDown={(e) => {
                      if (!isBlockingEnabled || locked) {
                        return;
                      }
                      if (e.button !== undefined && e.button !== 0) {
                        return;
                      }
                      e.preventDefault();
                      controllerRef.current?.handlePointerDown({
                        day,
                        startMinutes: hour.startMinutes,
                        isLocked: locked,
                        isBlocked: blocked,
                        pointerId: e.pointerId,
                        button: e.button,
                      });
                    }}
                    onPointerEnter={() => {
                      controllerRef.current?.handlePointerEnter({
                        day,
                        startMinutes: hour.startMinutes,
                      });
                    }}
                    onClick={() => {
                      controllerRef.current?.handleClick({
                        day,
                        startMinutes: hour.startMinutes,
                        isLocked: locked,
                      });
                    }}
                  >
                    {effectiveBlocked && <span className="timetable-blocked-badge">UNAVAILABLE</span>}
                  </button>
                );
              })}

              {/* Positioned Class Blocks Layer */}
              <div className="timetable-blocks-layer">
                {dayBlocks.map((block) => (
                  <div
                    key={block.key}
                    className={`timetable-block ${
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
                    }\nInstructor: ${block.facultySummary}`}
                  >
                    <span className="timetable-block__title">{block.title}</span>
                    {block.location && (
                      <span className="timetable-block__room">{block.location}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {isSolving && (
        <div className="timetable-solving-pill" role="status" aria-live="polite">
          <span className="spinner-dot" aria-hidden="true" />
          Solving CP-SAT model in WebAssembly...
        </div>
      )}
    </div>
  );
}
