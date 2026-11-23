import type { PreferencePriority, StudentPreferences } from '../types/domain.ts';
import { formatSliderTime12h } from '../ui/scheduleView.ts';

interface PreferencesTabProps {
  preferences: StudentPreferences;
  isSolving: boolean;
  onChangePreferences: (updater: (prev: StudentPreferences) => StudentPreferences) => void;
  onBack: () => void;
  onApplyConstraints: () => void;
}

const PRIORITY_OPTIONS: readonly PreferencePriority[] = ['Off', 'Low', 'Medium', 'High'];

interface WeightSelectProps {
  id: string;
  value: PreferencePriority;
  onChange: (value: PreferencePriority) => void;
}

function WeightSelect({ id, value, onChange }: WeightSelectProps) {
  return (
    <div className="weight-control">
      <label className="weight-control__label" htmlFor={id}>
        WEIGHT:
      </label>
      <select
        id={id}
        className="weight-control__select"
        value={value}
        onChange={(e) => onChange(e.target.value as PreferencePriority)}
      >
        {PRIORITY_OPTIONS.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}

export function PreferencesTab({
  preferences,
  isSolving,
  onChangePreferences,
  onBack,
  onApplyConstraints,
}: PreferencesTabProps) {
  return (
    <div className="tab-panel">
      <div className="tab-panel__scroll preferences-scroll">
        {/* Callout Banner matching Paper Files/1.2.png */}
        <div className="pref-callout">
          <h3 className="pref-callout__title">Optimizer Constraint Rules</h3>
          <p className="pref-callout__copy">
            Click timetable slots on the left to mark unworkable hours. Set your pacing preferences
            below to bias schedule generation.
          </p>
        </div>

        {/* 1. Fatigue Limit */}
        <section className="pref-card">
          <div className="pref-card__top">
            <div className="pref-card__info">
              <h4 className="pref-card__title">Fatigue Limit</h4>
              <p className="pref-card__desc">
                Enforces rest buffers between successive lecture blocks.
              </p>
            </div>
            <WeightSelect
              id="pref-weight-fatigue"
              value={preferences.fatigueLimit.priority}
              onChange={(priority) =>
                onChangePreferences((prev) => ({
                  ...prev,
                  fatigueLimit: { ...prev.fatigueLimit, priority },
                }))
              }
            />
          </div>

          <div className="slider-group">
            <div className="slider-group__header">
              <label className="slider-group__label" htmlFor="pref-slider-fatigue">
                Maximum consecutive hours:
              </label>
              <span className="slider-value-pill">
                {preferences.fatigueLimit.maxConsecutiveHours}{' '}
                {preferences.fatigueLimit.maxConsecutiveHours === 1 ? 'hour max' : 'hours max'}
              </span>
            </div>
            <input
              id="pref-slider-fatigue"
              type="range"
              className="maroon-slider"
              min={1}
              max={12}
              step={1}
              value={preferences.fatigueLimit.maxConsecutiveHours}
              onChange={(e) => {
                const maxConsecutiveHours = Number(e.target.value);
                onChangePreferences((prev) => ({
                  ...prev,
                  fatigueLimit: { ...prev.fatigueLimit, maxConsecutiveHours },
                }));
              }}
            />
            <div className="slider-ticks">
              <span>1 hr</span>
              <span>3 hrs</span>
              <span>6 hrs</span>
              <span>9 hrs</span>
              <span>12 hrs</span>
            </div>
          </div>
        </section>

        {/* 2. Acceptable Day Bounds */}
        <section className="pref-card">
          <div className="pref-card__top">
            <div className="pref-card__info">
              <h4 className="pref-card__title">Acceptable Day Bounds</h4>
              <p className="pref-card__desc">
                Constrain schedule within earliest start and latest end times.
              </p>
            </div>
            <WeightSelect
              id="pref-weight-bounds"
              value={preferences.acceptableDayBounds.priority}
              onChange={(priority) =>
                onChangePreferences((prev) => ({
                  ...prev,
                  acceptableDayBounds: { ...prev.acceptableDayBounds, priority },
                }))
              }
            />
          </div>

          <div className="slider-group">
            <div className="slider-group__header">
              <label className="slider-group__label" htmlFor="pref-slider-earliest">
                Earliest start:
              </label>
              <span className="slider-value-pill">
                {formatSliderTime12h(preferences.acceptableDayBounds.earliestStartMinutes)}
              </span>
            </div>
            <input
              id="pref-slider-earliest"
              type="range"
              className="maroon-slider"
              min={420}
              max={1140}
              step={30}
              value={preferences.acceptableDayBounds.earliestStartMinutes}
              onChange={(e) => {
                const earliestStartMinutes = Number(e.target.value);
                onChangePreferences((prev) => ({
                  ...prev,
                  acceptableDayBounds: {
                    ...prev.acceptableDayBounds,
                    earliestStartMinutes,
                    latestEndMinutes: Math.max(
                      earliestStartMinutes,
                      prev.acceptableDayBounds.latestEndMinutes
                    ),
                  },
                }));
              }}
            />
            <div className="slider-ticks">
              <span>07:00 AM</span>
              <span>10:00 AM</span>
              <span>01:00 PM</span>
              <span>04:00 PM</span>
              <span>07:00 PM</span>
            </div>
          </div>

          <div className="slider-group slider-group--spaced">
            <div className="slider-group__header">
              <label className="slider-group__label" htmlFor="pref-slider-latest">
                Latest end:
              </label>
              <span className="slider-value-pill">
                {formatSliderTime12h(preferences.acceptableDayBounds.latestEndMinutes)}
              </span>
            </div>
            <input
              id="pref-slider-latest"
              type="range"
              className="maroon-slider"
              min={420}
              max={1140}
              step={30}
              value={preferences.acceptableDayBounds.latestEndMinutes}
              onChange={(e) => {
                const latestEndMinutes = Number(e.target.value);
                onChangePreferences((prev) => ({
                  ...prev,
                  acceptableDayBounds: {
                    ...prev.acceptableDayBounds,
                    latestEndMinutes,
                    earliestStartMinutes: Math.min(
                      prev.acceptableDayBounds.earliestStartMinutes,
                      latestEndMinutes
                    ),
                  },
                }));
              }}
            />
            <div className="slider-ticks">
              <span>07:00 AM</span>
              <span>10:00 AM</span>
              <span>01:00 PM</span>
              <span>04:00 PM</span>
              <span>07:00 PM</span>
            </div>
          </div>
        </section>

        {/* 3. Minimize Friday classes */}
        <section className="pref-card">
          <div className="pref-card__top">
            <div className="pref-card__info">
              <h4 className="pref-card__title">Minimize Friday classes</h4>
              <p className="pref-card__desc">
                Penalizes Friday subjects to maximize study days.
              </p>
            </div>
            <WeightSelect
              id="pref-weight-friday"
              value={preferences.minimizeFridayClasses.priority}
              onChange={(priority) =>
                onChangePreferences((prev) => ({
                  ...prev,
                  minimizeFridayClasses: { priority },
                }))
              }
            />
          </div>
        </section>

        {/* 4. Batch subjects to fewer days */}
        <section className="pref-card">
          <div className="pref-card__top">
            <div className="pref-card__info">
              <h4 className="pref-card__title">Batch subjects to fewer days</h4>
              <p className="pref-card__desc">
                Favor TTh or WF clusters over dispersed daily attendance.
              </p>
            </div>
            <WeightSelect
              id="pref-weight-batch"
              value={preferences.batchSubjectsToFewerDays.priority}
              onChange={(priority) =>
                onChangePreferences((prev) => ({
                  ...prev,
                  batchSubjectsToFewerDays: { priority },
                }))
              }
            />
          </div>
        </section>

        {/* 5. Minimize Excessive Gaps */}
        <section className="pref-card">
          <div className="pref-card__top">
            <div className="pref-card__info">
              <h4 className="pref-card__title">Minimize Excessive Gaps</h4>
              <p className="pref-card__desc">
                Penalizes idle time greater than 2 hours between classes.
              </p>
            </div>
            <WeightSelect
              id="pref-weight-gaps"
              value={preferences.minimizeExcessiveGaps.priority}
              onChange={(priority) =>
                onChangePreferences((prev) => ({
                  ...prev,
                  minimizeExcessiveGaps: {
                    ...prev.minimizeExcessiveGaps,
                    priority,
                  },
                }))
              }
            />
          </div>
        </section>

        {/* 6. Starred Section Priority (Eq. 13 per SPEC.md Section 7.4) */}
        <section className="pref-card">
          <div className="pref-card__top">
            <div className="pref-card__info">
              <h4 className="pref-card__title">Prioritize Starred Sections</h4>
              <p className="pref-card__desc">
                Biases solver toward sections marked with a star in the Courses tab.
              </p>
            </div>
            <WeightSelect
              id="pref-weight-starred"
              value={preferences.starredSectionPreference.priority}
              onChange={(priority) =>
                onChangePreferences((prev) => ({
                  ...prev,
                  starredSectionPreference: { priority },
                }))
              }
            />
          </div>
        </section>
      </div>

      {/* Bottom 2-button Footer matching Paper Files/1.2.png */}
      <div className="tab-panel__footer tab-panel__footer--split">
        <button type="button" className="btn-secondary-outline" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="btn-cta-primary"
          disabled={isSolving}
          onClick={onApplyConstraints}
        >
          {isSolving ? 'Applying...' : 'Apply Constraints'}
        </button>
      </div>
    </div>
  );
}
