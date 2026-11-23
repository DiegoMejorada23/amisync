import type { AcademicPlanState, Weekday } from '../types/domain.ts';
import type { GeneratedScheduleAlternative } from '../types/solver.ts';
import {
  buildTimetableBlocks,
  GRID_DAY_HEADERS,
  GRID_DAYS,
  GRID_HOURS,
  isCellLockedByPreEnlisted,
  type TimetableBlock,
} from '../ui/scheduleView.ts';

interface TimetableGridProps {
  plan: AcademicPlanState;
  activeAlternative: GeneratedScheduleAlternative | null;
  isSolving: boolean;
  onToggleCell: (day: Weekday, startMinutes: number) => void;
}

export function TimetableGrid({
  plan,
  activeAlternative,
  isSolving,
  onToggleCell,
}: TimetableGridProps) {
  const blocks = buildTimetableBlocks(plan, activeAlternative);

  const blocksByDay = new Map<Weekday, TimetableBlock[]>();
  for (const day of GRID_DAYS) {
    blocksByDay.set(day, []);
  }
  for (const block of blocks) {
    blocksByDay.get(block.day)?.push(block);
  }

  const isCellBlocked = (day: Weekday, startMinutes: number, endMinutes: number): boolean =>
    plan.blockedCells.some(
      (cell) =>
        cell.day === day &&
        cell.startMinutes < endMinutes &&
        startMinutes < cell.endMinutes
    );

  return (
    <div className="timetable-wrapper" aria-busy={isSolving}>
      <div className="timetable-grid" role="grid" aria-label="Weekly schedule timetable">
        {/* Header Row */}
        <div className="timetable-header timetable-header--time" role="columnheader">
          TIME
        </div>
        {GRID_DAYS.map((day) => (
          <div key={day} className="timetable-header" role="columnheader">
            {GRID_DAY_HEADERS[day]}
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
                const blocked = isCellBlocked(day, hour.startMinutes, hour.endMinutes);
                const locked = isCellLockedByPreEnlisted(
                  plan,
                  day,
                  hour.startMinutes,
                  hour.endMinutes
                );

                return (
                  <button
                    key={`${day}-${hour.startMinutes}`}
                    type="button"
                    className={`timetable-slot ${blocked ? 'timetable-slot--blocked' : ''} ${
                      locked ? 'timetable-slot--locked-underlay' : ''
                    }`}
                    disabled={locked}
                    aria-pressed={blocked}
                    aria-label={
                      locked
                        ? `${day} ${hour.label}: Locked pre-enlisted class`
                        : blocked
                          ? `${day} ${hour.label}: Blocked. Click to unblock.`
                          : `${day} ${hour.label}: Available. Click to block.`
                    }
                    onClick={() => onToggleCell(day, hour.startMinutes)}
                  >
                    {blocked && <span className="timetable-blocked-badge">BLOCKED</span>}
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
