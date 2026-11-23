import {
  PRIORITY_WEIGHT_MAP,
  WEEKDAYS,
  type StudentPreferences,
} from '../types/domain.ts';
import type { DayOccurrence, PreprocessedProblem } from './preprocess.ts';

export type SoftPenaltyKey =
  | 'early'
  | 'late'
  | 'friday'
  | 'days'
  | 'fatigue'
  | 'section'
  | 'gap';

export const SOFT_PENALTY_KEYS: readonly SoftPenaltyKey[] = [
  'early',
  'late',
  'friday',
  'days',
  'fatigue',
  'section',
  'gap',
] as const;

export type SoftPenaltyMap = Record<SoftPenaltyKey, number>;

export interface ObjectiveWeightsSummary {
  rawWeights: SoftPenaltyMap;
  totalWeight: number;
  normalizedWeights10k: SoftPenaltyMap;
  isPureSatisfiability: boolean;
}

export interface EvaluatedObjective {
  rawPenalties: SoftPenaltyMap;
  maxPenalties: SoftPenaltyMap;
  normalizedPenalties: SoftPenaltyMap;
  weights: ObjectiveWeightsSummary;
  objectiveScoreZ: number;
}

/**
 * Common positive integer scale factor S_prec used in CP-SAT integer objective linearization
 * (SPEC.md Section 5.4). Keeps scaled coefficients well within safe 32/53-bit integer bounds.
 */
export const OBJECTIVE_PRECISION_SCALE = 1000;

/**
 * Checks whether two nodes cannot be simultaneously selected because they are distinct
 * alternatives of the same (courseKey, component) group.
 */
export function areSameComponentMutuallyExclusive(
  problem: PreprocessedProblem,
  nodeIndexA: number,
  nodeIndexB: number
): boolean {
  if (nodeIndexA === nodeIndexB) {
    return false;
  }
  const a = problem.nodes[nodeIndexA];
  const b = problem.nodes[nodeIndexB];
  return a.courseKey === b.courseKey && a.component === b.component;
}

/**
 * Builds a fast lookup set of overlapping node index pairs.
 */
export function buildOverlapPairSet(problem: PreprocessedProblem): Set<string> {
  const set = new Set<string>();
  for (const [i, j] of problem.overlappingPairs) {
    set.add(`${i}:${j}`);
    set.add(`${j}:${i}`);
  }
  return set;
}

export function nodesConflict(
  problem: PreprocessedProblem,
  overlapSet: Set<string>,
  nodeIndexA: number,
  nodeIndexB: number
): boolean {
  if (nodeIndexA === nodeIndexB) {
    return false;
  }
  if (areSameComponentMutuallyExclusive(problem, nodeIndexA, nodeIndexB)) {
    return true;
  }
  return overlapSet.has(`${nodeIndexA}:${nodeIndexB}`);
}

/**
 * Computes the effective preference weights W_n in {0, 2, 5, 10} and the 10,000-scaled
 * normalized integer weights Round(10000 * W_n / sum(W)) per SPEC.md Eq. (15).
 */
export function computeObjectiveWeights(
  problem: PreprocessedProblem,
  preferences: StudentPreferences
): ObjectiveWeightsSummary {
  const boundsWeight = PRIORITY_WEIGHT_MAP[preferences.acceptableDayBounds.priority];
  const rawWeights: SoftPenaltyMap = {
    early: boundsWeight,
    late: boundsWeight,
    friday: PRIORITY_WEIGHT_MAP[preferences.minimizeFridayClasses.priority],
    days: PRIORITY_WEIGHT_MAP[preferences.batchSubjectsToFewerDays.priority],
    fatigue: PRIORITY_WEIGHT_MAP[preferences.fatigueLimit.priority],
    section: problem.anyStarredSelectable
      ? PRIORITY_WEIGHT_MAP[preferences.starredSectionPreference.priority]
      : 0,
    gap: PRIORITY_WEIGHT_MAP[preferences.minimizeExcessiveGaps.priority],
  };

  const totalWeight = SOFT_PENALTY_KEYS.reduce((acc, k) => acc + rawWeights[k], 0);
  const isPureSatisfiability = totalWeight === 0;

  const normalizedWeights10k: SoftPenaltyMap = {
    early: 0,
    late: 0,
    friday: 0,
    days: 0,
    fatigue: 0,
    section: 0,
    gap: 0,
  };

  if (!isPureSatisfiability) {
    for (const key of SOFT_PENALTY_KEYS) {
      normalizedWeights10k[key] = Math.round((10000 * rawWeights[key]) / totalWeight);
    }
  }

  return {
    rawWeights,
    totalWeight,
    normalizedWeights10k,
    isPureSatisfiability,
  };
}

/**
 * Computes the maximum possible continuous back-to-back run ending at each occurrence on a day.
 */
export function computeMaxContinuousRunByOccurrence(
  problem: PreprocessedProblem,
  overlapSet: Set<string>,
  occurrences: readonly DayOccurrence[]
): number[] {
  // Sort indices by end time ascending so predecessors (p.end === o.start) are processed first.
  const order = occurrences
    .map((_, idx) => idx)
    .sort((a, b) => occurrences[a].end - occurrences[b].end || occurrences[a].start - occurrences[b].start);

  const maxRun = new Array<number>(occurrences.length).fill(0);

  for (const idx of order) {
    const occ = occurrences[idx];
    let bestPred = 0;
    for (let pIdx = 0; pIdx < occurrences.length; pIdx++) {
      if (pIdx === idx) continue;
      const pred = occurrences[pIdx];
      if (pred.end !== occ.start) continue;
      if (nodesConflict(problem, overlapSet, pred.nodeIndex, occ.nodeIndex)) continue;
      if (maxRun[pIdx] > bestPred) {
        bestPred = maxRun[pIdx];
      }
    }
    maxRun[idx] = occ.duration + bestPred;
  }

  return maxRun;
}

/**
 * Dynamically computes theoretical upper bounds P_{max, n} for all 7 soft penalty terms
 * directly from the student's preprocessed input bounds (SPEC.md Section 5.4).
 */
export function computeDynamicMaxPenalties(
  problem: PreprocessedProblem,
  preferences: StudentPreferences
): SoftPenaltyMap {
  const overlapSet = buildOverlapPairSet(problem);
  const prefStart = preferences.acceptableDayBounds.earliestStartMinutes;
  const prefEnd = preferences.acceptableDayBounds.latestEndMinutes;
  const fatigueThresholdMin = Math.max(
    1,
    Math.round(preferences.fatigueLimit.maxConsecutiveHours * 60)
  );
  const gapThresholdMin = preferences.minimizeExcessiveGaps.gapThresholdMinutes;

  // 1 & 2. Early Start & Late End
  let maxEarly = 0;
  let maxLate = 0;
  let activeCandidateDays = 0;
  let maxFatigue = 0;
  let maxGap = 0;

  for (const day of WEEKDAYS) {
    const occs = problem.occurrencesByDay[day];
    if (occs.length === 0) {
      continue;
    }
    activeCandidateDays += 1;

    let dayMaxEarly = 0;
    let dayMaxLate = 0;
    let dayMinStart = Number.POSITIVE_INFINITY;
    let dayMaxEnd = Number.NEGATIVE_INFINITY;

    for (const o of occs) {
      const e = Math.max(0, prefStart - o.start);
      if (e > dayMaxEarly) dayMaxEarly = e;

      const l = Math.max(0, o.end - prefEnd);
      if (l > dayMaxLate) dayMaxLate = l;

      if (o.start < dayMinStart) dayMinStart = o.start;
      if (o.end > dayMaxEnd) dayMaxEnd = o.end;
    }
    maxEarly += dayMaxEarly;
    maxLate += dayMaxLate;

    // 5. Fatigue upper bound on day d
    const maxRuns = computeMaxContinuousRunByOccurrence(problem, overlapSet, occs);
    const peakRun = maxRuns.reduce((m, v) => (v > m ? v : m), 0);
    if (peakRun > fatigueThresholdMin) {
      // Bound total class minutes selectable on day d by sum of max node-duration per (course, component).
      const nodeDayDur = new Map<number, number>();
      for (const o of occs) {
        nodeDayDur.set(o.nodeIndex, (nodeDayDur.get(o.nodeIndex) ?? 0) + o.duration);
      }
      const compMaxDur = new Map<string, number>();
      for (const [nodeIdx, dur] of nodeDayDur.entries()) {
        const node = problem.nodes[nodeIdx];
        const groupKey = `${node.courseKey}::${node.component}`;
        const prev = compMaxDur.get(groupKey) ?? 0;
        if (dur > prev) compMaxDur.set(groupKey, dur);
      }
      let sumCompDur = 0;
      for (const dur of compMaxDur.values()) {
        sumCompDur += dur;
      }
      const daySpan = dayMaxEnd - dayMinStart;
      const maxSelectableDur = Math.min(sumCompDur, daySpan);
      maxFatigue += Math.max(0, maxSelectableDur - fatigueThresholdMin);
    }

    // 7. Excessive gap upper bound on day d
    let maxSinglePairExcess = 0;
    let minPairEnd = Number.POSITIVE_INFINITY;
    let maxPairStart = Number.NEGATIVE_INFINITY;
    let hasAnyGapPair = false;

    for (let i = 0; i < occs.length; i++) {
      for (let j = i + 1; j < occs.length; j++) {
        const a = occs[i];
        const b = occs[j];
        const excess = b.start - a.end - gapThresholdMin;
        if (excess <= 0) continue;
        if (nodesConflict(problem, overlapSet, a.nodeIndex, b.nodeIndex)) continue;

        hasAnyGapPair = true;
        if (excess > maxSinglePairExcess) maxSinglePairExcess = excess;
        if (a.end < minPairEnd) minPairEnd = a.end;
        if (b.start > maxPairStart) maxPairStart = b.start;
      }
    }

    if (hasAnyGapPair) {
      const spanExcess = Math.max(0, maxPairStart - minPairEnd - gapThresholdMin);
      maxGap += Math.max(maxSinglePairExcess, spanExcess);
    }
  }

  // 3. Friday classes: count (course, component) groups having at least one Friday option.
  let maxFriday = 0;
  for (const course of problem.courses) {
    for (const nodeIndices of course.nodeIndicesByComponent.values()) {
      if (nodeIndices.some((idx) => problem.nodes[idx].meetsOnFriday)) {
        maxFriday += 1;
      }
    }
  }

  // 4. Active days: at most min(6, days with candidate occurrences).
  const maxDays = Math.min(6, activeCandidateDays);

  // 6. Starred section penalty: count (course, component) groups having an explicit selectable unstarred node.
  let maxSection = 0;
  if (problem.anyStarredSelectable) {
    for (const course of problem.courses) {
      for (const nodeIndices of course.nodeIndicesByComponent.values()) {
        const hasUnstarredSelectable = nodeIndices.some((idx) => {
          const n = problem.nodes[idx];
          return !n.isPreEnlisted && n.isExplicitOption && !n.flags.isStarred;
        });
        if (hasUnstarredSelectable) {
          maxSection += 1;
        }
      }
    }
  }

  return {
    early: maxEarly,
    late: maxLate,
    friday: maxFriday,
    days: maxDays,
    fatigue: maxFatigue,
    section: maxSection,
    gap: maxGap,
  };
}

/**
 * Independently computes exact raw penalties (Eq. 8–14) and composite integer-weighted
 * normalized objective Z (Eq. 15) for a selected set of node indices.
 */
export function evaluateSelectionObjective(
  problem: PreprocessedProblem,
  selectedNodeIndices: ReadonlySet<number>,
  preferences: StudentPreferences
): EvaluatedObjective {
  const weights = computeObjectiveWeights(problem, preferences);
  const maxPenalties = computeDynamicMaxPenalties(problem, preferences);

  const prefStart = preferences.acceptableDayBounds.earliestStartMinutes;
  const prefEnd = preferences.acceptableDayBounds.latestEndMinutes;
  const fatigueThresholdMin = Math.max(
    1,
    Math.round(preferences.fatigueLimit.maxConsecutiveHours * 60)
  );
  const gapThresholdMin = preferences.minimizeExcessiveGaps.gapThresholdMinutes;

  let rawEarly = 0;
  let rawLate = 0;
  let rawDays = 0;
  let rawFatigue = 0;
  let rawGap = 0;

  for (const day of WEEKDAYS) {
    const selectedOccs = problem.occurrencesByDay[day]
      .filter((o) => selectedNodeIndices.has(o.nodeIndex))
      .sort((a, b) => a.start - b.start || a.end - b.end);

    if (selectedOccs.length === 0) {
      continue;
    }

    rawDays += 1;

    // Early start (first class on day d) and Late end (last class on day d)
    const firstStart = selectedOccs[0].start;
    let lastEnd = selectedOccs[0].end;
    for (const occ of selectedOccs) {
      if (occ.end > lastEnd) lastEnd = occ.end;
    }

    rawEarly += Math.max(0, prefStart - firstStart);
    rawLate += Math.max(0, lastEnd - prefEnd);

    // Consecutive blocks (fatigue) and consecutive gaps
    let blockStart = selectedOccs[0].start;
    let blockEnd = selectedOccs[0].end;

    for (let i = 1; i < selectedOccs.length; i++) {
      const prev = selectedOccs[i - 1];
      const curr = selectedOccs[i];
      const gap = curr.start - prev.end;

      if (gap === 0) {
        // Continuous back-to-back block continues
        if (curr.end > blockEnd) {
          blockEnd = curr.end;
        }
      } else {
        // Close previous continuous block
        rawFatigue += Math.max(0, blockEnd - blockStart - fatigueThresholdMin);

        // Excessive gap (> 120 min)
        if (gap > gapThresholdMin) {
          rawGap += gap - gapThresholdMin;
        }

        blockStart = curr.start;
        blockEnd = curr.end;
      }
    }

    // Close final continuous block on day d
    rawFatigue += Math.max(0, blockEnd - blockStart - fatigueThresholdMin);
  }

  let rawFriday = 0;
  let rawSection = 0;

  for (const nodeIdx of selectedNodeIndices) {
    const node = problem.nodes[nodeIdx];
    if (node.meetsOnFriday) {
      rawFriday += 1;
    }
    if (
      problem.anyStarredSelectable &&
      !node.isPreEnlisted &&
      node.isExplicitOption &&
      !node.flags.isStarred
    ) {
      rawSection += 1;
    }
  }

  const rawPenalties: SoftPenaltyMap = {
    early: rawEarly,
    late: rawLate,
    friday: rawFriday,
    days: rawDays,
    fatigue: rawFatigue,
    section: rawSection,
    gap: rawGap,
  };

  const normalizedPenalties: SoftPenaltyMap = {
    early: 0,
    late: 0,
    friday: 0,
    days: 0,
    fatigue: 0,
    section: 0,
    gap: 0,
  };

  let objectiveScoreZ = 0;
  if (!weights.isPureSatisfiability) {
    for (const key of SOFT_PENALTY_KEYS) {
      const pMax = maxPenalties[key];
      if (pMax > 0) {
        const norm = rawPenalties[key] / pMax;
        normalizedPenalties[key] = norm;
        objectiveScoreZ += weights.normalizedWeights10k[key] * norm;
      }
    }
  }

  return {
    rawPenalties,
    maxPenalties,
    normalizedPenalties,
    weights,
    objectiveScoreZ: Number(objectiveScoreZ.toFixed(4)),
  };
}
