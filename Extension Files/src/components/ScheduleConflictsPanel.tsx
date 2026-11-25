import type { InfeasibilityDiagnosis, RelaxationAction } from '../types/solver.ts';
import { parseConflictBullet } from '../ui/scheduleView.ts';

interface ScheduleConflictsPanelProps {
  diagnosis: InfeasibilityDiagnosis | null;
  isSolving: boolean;
  onApplyRelaxation: (action: RelaxationAction) => void;
}

function getDiagnosisHeading(diagnosis: InfeasibilityDiagnosis): string {
  switch (diagnosis.origin) {
    case 'EXHAUSTED_CAPACITY':
      return 'Course Capacity Exhausted: No Open Non-TBA Sections';
    case 'DATA_INCONSISTENCY':
      return 'Foundational Schedule Conflict: Pre-Enlisted / Structural Inconsistency';
    case 'SOLVER_RESOURCE_FALLBACK':
      return 'Model Infeasible: Solver Resource Budget Reached';
    case 'PREFERENCE_CONFLICT':
    default:
      return 'Model Infeasible: Minimal Unsatisfiable Subset (MUS) Extracted';
  }
}

export function ScheduleConflictsPanel({
  diagnosis,
  isSolving,
  onApplyRelaxation,
}: ScheduleConflictsPanelProps) {
  const verifiedActionIds = new Set(
    (diagnosis?.fallbackOptions ?? []).map((opt) => opt.relaxation.id)
  );

  const isExpanded = diagnosis !== null;

  return (
    <section
      className={`conflicts-panel ${
        isExpanded ? 'conflicts-panel--expanded' : 'conflicts-panel--compact'
      }`}
      aria-label="Schedule Conflicts"
    >
      <div className="conflicts-panel__header">
        <span className="conflicts-panel__title">SCHEDULE CONFLICTS</span>
        {isSolving ? (
          <span className="conflicts-panel__badge conflicts-panel__badge--solving">
            OPTIMIZING
          </span>
        ) : diagnosis ? (
          <span className="conflicts-panel__badge">INFEASIBLE</span>
        ) : (
          <span className="conflicts-panel__badge conflicts-panel__badge--clear">
            0 HARD CLASHES
          </span>
        )}
      </div>

      <div className="conflicts-panel__body">
        {diagnosis ? (
          <div className="conflicts-alert">
            <h3 className="conflicts-alert__heading">{getDiagnosisHeading(diagnosis)}</h3>

            <ul className="conflicts-alert__list">
              {diagnosis.conflictSummaryBullets.map((bullet, idx) => {
                const parsed = parseConflictBullet(bullet, diagnosis.affectedCourseCodes);
                return (
                  <li key={`bullet-${idx}`} className="conflicts-alert__item">
                    {parsed.prefix && <strong>{parsed.prefix}</strong>}
                    {parsed.segments.map((seg, segIdx) =>
                      seg.type === 'course' ? (
                        <code key={`seg-${segIdx}`} className="course-inline-pill">
                          {seg.value}
                        </code>
                      ) : (
                        <span key={`seg-${segIdx}`}>{seg.value}</span>
                      )
                    )}
                  </li>
                );
              })}

              {diagnosis.relaxationSuggestions.map((suggestion, idx) => (
                <li key={`suggest-${idx}`} className="conflicts-alert__item conflicts-alert__item--advice">
                  {suggestion}
                </li>
              ))}
            </ul>

            <hr className="conflicts-alert__divider" />

            {diagnosis.relaxationActions && diagnosis.relaxationActions.length > 0 && (
              <div className="conflicts-actions">
                {diagnosis.relaxationActions.map((action) => {
                  const isVerified = verifiedActionIds.has(action.id);
                  const isCourseDrop = action.actionType === 'DROP_OR_REPLACE_COURSE';
                  return (
                    <button
                      key={action.id}
                      type="button"
                      className={`conflicts-action-btn ${
                        isVerified ? 'conflicts-action-btn--verified' : ''
                      } ${isCourseDrop ? 'conflicts-action-btn--secondary' : ''}`}
                      title={action.description}
                      disabled={isSolving}
                      onClick={() => onApplyRelaxation(action)}
                    >
                      <span>{action.label}</span>
                      {isVerified && (
                        <span className="conflicts-action-tag">Verified Fix</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <p className="conflicts-empty-summary">
            {isSolving
              ? 'Checking hard constraints and optimizing feasible schedules in WebAssembly...'
              : 'No active schedule conflicts. QuickXplain diagnostics and 1-click fixes appear here if infeasible.'}
          </p>
        )}
      </div>
    </section>
  );
}
