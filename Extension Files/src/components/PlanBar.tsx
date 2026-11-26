import type { GeneratedScheduleAlternative } from '../types/solver.ts';
import { MAX_COMPARED_PLANS } from '../ui/planComparison.ts';
import { formatPlanOptionLabel } from '../ui/scheduleView.ts';
import { CompareIcon } from './Icons.tsx';

interface PlanBarProps {
  alternatives: readonly GeneratedScheduleAlternative[];
  selectedPlanIndex: number;
  fallbackTotalUnits: number;
  isInfeasible: boolean;
  onSelectPlan: (index: number) => void;
  onOpenCompare?: () => void;
}

export function PlanBar({
  alternatives,
  selectedPlanIndex,
  fallbackTotalUnits,
  isInfeasible,
  onSelectPlan,
  onOpenCompare,
}: PlanBarProps) {
  const activeAlt = alternatives[selectedPlanIndex] ?? null;
  const comparableCount = Math.min(alternatives.length, MAX_COMPARED_PLANS);

  return (
    <div className="plan-bar">
      <div className="plan-bar__selector-group">
        <label className="plan-bar__label" htmlFor="amisync-plan-select">
          PLAN :
        </label>

        {alternatives.length > 0 ? (
          <>
            <select
              id="amisync-plan-select"
              className="plan-bar__select"
              value={selectedPlanIndex}
              onChange={(e) => onSelectPlan(Number(e.target.value))}
            >
              {alternatives.map((alt, idx) => (
                <option key={`${alt.planLabel}-${idx}`} value={idx}>
                  {formatPlanOptionLabel(alt, idx)}
                </option>
              ))}
            </select>
            {activeAlt && (
              <span
                className={`plan-status-pill plan-status-pill--${
                  activeAlt.status === 'OPTIMAL' ? 'optimal' : 'feasible'
                }`}
                title={`Solver status: ${activeAlt.status} | Penalty score Z = ${activeAlt.objectiveScoreZ}`}
              >
                {activeAlt.status === 'OPTIMAL' ? 'OPTIMAL' : 'FEASIBLE'}
              </span>
            )}
            {comparableCount >= 2 && (
              <button
                type="button"
                className="plan-bar__compare-btn"
                title={`Compare ${comparableCount} generated plans side-by-side`}
                onClick={() => onOpenCompare?.()}
              >
                <CompareIcon width={12} height={12} />
                <span>Compare ({comparableCount})</span>
              </button>
            )}
          </>
        ) : (
          <select
            id="amisync-plan-select"
            className="plan-bar__select plan-bar__select--empty"
            disabled
            value="empty"
          >
            <option value="empty">
              {isInfeasible
                ? `No Feasible Plan (${fallbackTotalUnits} Units)`
                : `Draft Schedule (${fallbackTotalUnits} Units) - Not Generated`}
            </option>
          </select>
        )}
      </div>

      <div className="plan-bar__legend" title="Pre-enlisted AMIS classes are fixed and cannot be moved">
        <span className="legend-swatch legend-swatch--locked" aria-hidden="true" />
        <span className="legend-label">Pre-enlisted</span>
      </div>
    </div>
  );
}
