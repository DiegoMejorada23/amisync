import {
  CpModel,
  LinearExpr,
  type BoolVar,
  type IntVar,
  type LinearExprLike,
  type LiteralLike,
} from 'or-tools-wasm/cp-sat';
import { WEEKDAYS, type StudentPreferences } from '../types/domain.ts';
import {
  buildOverlapPairSet,
  computeDynamicMaxPenalties,
  computeMaxContinuousRunByOccurrence,
  computeObjectiveWeights,
  nodesConflict,
  OBJECTIVE_PRECISION_SCALE,
  type ObjectiveWeightsSummary,
  type SoftPenaltyMap,
} from './objective.ts';
import type { PreprocessedProblem } from './preprocess.ts';

export interface ExclusionCut {
  /** Flexible (non-pre-enlisted) node indices that were selected in a prior schedule S_i. */
  nodeIndices: number[];
  /** Minimum number of sections m that must differ from S_i (Eq. 16). */
  minDiff: number;
}

export interface BuiltCpSatModel {
  model: CpModel;
  xVars: BoolVar[];
  weights: ObjectiveWeightsSummary;
  maxPenalties: SoftPenaltyMap;
  /** True if an exclusion cut or structural bound is immediately unsatisfiable prior to solve. */
  triviallyInfeasible: boolean;
}

const UNIT_SCALE = 100;

/**
 * Constructs the complete CP-SAT optimization model matching SPEC.md Section 5:
 * - Decision variables x_{c,k,s} in {0, 1}
 * - Hard constraints: Eq. (1) pre-enlisted locking, Eq. (2) component satisfaction,
 *   Eq. (3) co-requisite linkage, Eq. (4)-(5) pairwise temporal exclusivity,
 *   Eq. (6) user-hidden sections, Eq. (7) user time-blocks, user-locked sections,
 *   optional academic plan unit limits, and Eq. (16) iterative exclusion cuts.
 * - Soft constraints (when sum(W) > 0): Eq. (8)-(15) integer-linearized weighted-penalty objective Z.
 */
export function buildCpSatModel(
  problem: PreprocessedProblem,
  preferences: StudentPreferences,
  exclusionCuts: readonly ExclusionCut[] = []
): BuiltCpSatModel {
  const model = new CpModel();
  const xVars: BoolVar[] = problem.nodes.map((node) =>
    model.newBoolVar(`x_${node.nodeIndex}_${node.sectionId}`)
  );

  const weights = computeObjectiveWeights(problem, preferences);
  const maxPenalties = computeDynamicMaxPenalties(problem, preferences);

  let triviallyInfeasible = false;

  // =========================================================================
  // 1. HARD CONSTRAINTS (SPEC.md Sections 5.2 & 5.3)
  // =========================================================================

  // Eq. (1): Pre-Enlisted Course Locking (x_{c,k,s} = 1)
  // Eq. (6): User-Excluded Sections — Hide (x_{c,k,s} = 0)
  // Eq. (7): User Time-Blocks (x_{c,k,s} = 0)
  // UI Padlock: User-Locked Sections (x_{c,k,s} = 1)
  for (const node of problem.nodes) {
    const x = xVars[node.nodeIndex];

    if (node.isPreEnlisted) {
      model.addEquality(x, 1);
    }

    if (node.flags.isLocked) {
      model.addEquality(x, 1);
    }

    if (!node.isPreEnlisted && node.flags.isHidden) {
      model.addEquality(x, 0);
    }

    if (problem.blockedNodeIndices.has(node.nodeIndex)) {
      model.addEquality(x, 0);
    }
  }

  // Eq. (2): Component Satisfaction (sum_s x_{c,k,s} = 1 for every required component k of course c)
  for (const course of problem.courses) {
    for (const comp of course.requiredComponents) {
      const indices = course.nodeIndicesByComponent.get(comp) ?? [];
      if (indices.length === 0) {
        triviallyInfeasible = true;
        model.addLinearConstraint(0, 1, 1);
      } else if (indices.length === 1) {
        model.addEquality(xVars[indices[0]], 1);
      } else {
        model.addExactlyOne(indices.map((idx) => xVars[idx]));
      }
    }

    // Eq. (3): Component Co-Requisite Linkage (sum_{l in child(p)} x_{c,child,l} = x_{c,parent,p})
    for (const group of course.linkageGroups) {
      const parentVar = xVars[group.parentNodeIndex];
      if (group.childNodeIndices.length === 0) {
        model.addEquality(parentVar, 0);
      } else if (group.childNodeIndices.length === 1) {
        model.addEquality(xVars[group.childNodeIndices[0]], parentVar);
      } else {
        model.addEquality(
          LinearExpr.sum(group.childNodeIndices.map((idx) => xVars[idx])),
          parentVar
        );
      }
    }
  }

  // Eq. (4) & Eq. (5): Pairwise Temporal Exclusivity (x_i + x_j <= 1)
  for (const [i, j] of problem.overlappingPairs) {
    model.addAtMostOne([xVars[i], xVars[j]]);
  }

  // Optional Academic Plan Unit Limits (minUnits / maxUnits)
  if (problem.unitLimits) {
    const { minUnits, maxUnits } = problem.unitLimits;
    const hasMin = typeof minUnits === 'number' && Number.isFinite(minUnits);
    const hasMax = typeof maxUnits === 'number' && Number.isFinite(maxUnits);

    if (hasMin || hasMax) {
      const unitTerms: LinearExprLike[] = [];
      const unitCoeffs: number[] = [];

      for (const course of problem.courses) {
        const scaledUnits = Math.round(course.units * UNIT_SCALE);
        if (scaledUnits <= 0) continue;

        // Pick one representative required component of the course (whose sum is 1 when scheduled).
        const repComp = course.requiredComponents[0];
        const repIndices = repComp ? course.nodeIndicesByComponent.get(repComp) ?? [] : [];
        for (const idx of repIndices) {
          unitTerms.push(xVars[idx]);
          unitCoeffs.push(scaledUnits);
        }
      }

      const lb = hasMin ? Math.round(minUnits * UNIT_SCALE) : 0;
      const ub = hasMax ? Math.round(maxUnits * UNIT_SCALE) : Number.MAX_SAFE_INTEGER;

      if (lb > ub) {
        triviallyInfeasible = true;
        model.addLinearConstraint(0, 1, 1);
      } else if (unitTerms.length === 0) {
        if (lb > 0) {
          triviallyInfeasible = true;
          model.addLinearConstraint(0, 1, 1);
        }
      } else {
        const totalUnitsExpr = LinearExpr.weightedSum(unitTerms, unitCoeffs);
        model.addLinearConstraint(totalUnitsExpr, lb, ub);
      }
    }
  }

  // Eq. (16): Accumulating Iterative Exclusion / No-Good Cuts (strictly excluding pre-enlisted sections)
  // For baseline diversity (minDiff = 1), forbids the exact chosen set: sum_{v in chosen} v <= len(chosen) - 1.
  for (const cut of exclusionCuts) {
    const uniqueIndices = Array.from(new Set(cut.nodeIndices));
    if (uniqueIndices.length === 0) {
      continue;
    }
    const upperBound = uniqueIndices.length - cut.minDiff;
    if (upperBound < 0) {
      triviallyInfeasible = true;
      model.addLinearConstraint(0, 1, 1);
    } else if (uniqueIndices.length === 1 && upperBound === 0) {
      model.addEquality(xVars[uniqueIndices[0]], 0);
    } else {
      model.addLinearConstraint(
        LinearExpr.sum(uniqueIndices.map((idx) => xVars[idx])),
        0,
        upperBound
      );
    }
  }

  // =========================================================================
  // 2. SOFT CONSTRAINTS & WEIGHTED-PENALTY OBJECTIVE (SPEC.md Section 5.4)
  // =========================================================================

  // Zero-Weight Exception: Pure Satisfiability Mode (Z = 0)
  if (weights.isPureSatisfiability || triviallyInfeasible) {
    return {
      model,
      xVars,
      weights,
      maxPenalties,
      triviallyInfeasible,
    };
  }

  const objectiveTerms: LinearExprLike[] = [];
  const objectiveCoeffs: number[] = [];

  const pushObjectiveTerm = (
    expr: LinearExprLike,
    weight10k: number,
    pMax: number
  ): void => {
    if (weight10k <= 0 || pMax <= 0) {
      return;
    }
    const scaledCoeff = Math.max(
      1,
      Math.round((weight10k * OBJECTIVE_PRECISION_SCALE) / pMax)
    );
    objectiveTerms.push(expr);
    objectiveCoeffs.push(scaledCoeff);
  };

  const overlapSet = buildOverlapPairSet(problem);
  const prefStart = preferences.acceptableDayBounds.earliestStartMinutes;
  const prefEnd = preferences.acceptableDayBounds.latestEndMinutes;
  const fatigueThresholdMin = Math.max(
    1,
    Math.round(preferences.fatigueLimit.maxConsecutiveHours * 60)
  );
  const gapThresholdMin = preferences.minimizeExcessiveGaps.gapThresholdMinutes;

  // --- Eq. (8): Early Start Penalty P_early ---
  if (weights.normalizedWeights10k.early > 0 && maxPenalties.early > 0) {
    const dayVars: IntVar[] = [];
    for (const day of WEEKDAYS) {
      const occs = problem.occurrencesByDay[day];
      const penExprs: LinearExprLike[] = [0];
      let dayMax = 0;

      for (const o of occs) {
        const earlyMin = Math.max(0, prefStart - o.start);
        if (earlyMin > 0) {
          penExprs.push(xVars[o.nodeIndex].times(earlyMin));
          if (earlyMin > dayMax) dayMax = earlyMin;
        }
      }

      if (dayMax > 0) {
        const dayPen = model.newIntVar(0, dayMax, `early_${day}`);
        model.addMaxEquality(dayPen, penExprs);
        dayVars.push(dayPen);
      }
    }
    if (dayVars.length > 0) {
      pushObjectiveTerm(
        LinearExpr.sum(dayVars),
        weights.normalizedWeights10k.early,
        maxPenalties.early
      );
    }
  }

  // --- Eq. (9): Late End Penalty P_late ---
  if (weights.normalizedWeights10k.late > 0 && maxPenalties.late > 0) {
    const dayVars: IntVar[] = [];
    for (const day of WEEKDAYS) {
      const occs = problem.occurrencesByDay[day];
      const penExprs: LinearExprLike[] = [0];
      let dayMax = 0;

      for (const o of occs) {
        const lateMin = Math.max(0, o.end - prefEnd);
        if (lateMin > 0) {
          penExprs.push(xVars[o.nodeIndex].times(lateMin));
          if (lateMin > dayMax) dayMax = lateMin;
        }
      }

      if (dayMax > 0) {
        const dayPen = model.newIntVar(0, dayMax, `late_${day}`);
        model.addMaxEquality(dayPen, penExprs);
        dayVars.push(dayPen);
      }
    }
    if (dayVars.length > 0) {
      pushObjectiveTerm(
        LinearExpr.sum(dayVars),
        weights.normalizedWeights10k.late,
        maxPenalties.late
      );
    }
  }

  // --- Eq. (10): Friday Class Penalty P_friday ---
  if (weights.normalizedWeights10k.friday > 0 && maxPenalties.friday > 0) {
    const fridayVars = problem.nodes
      .filter((n) => n.meetsOnFriday)
      .map((n) => xVars[n.nodeIndex]);
    if (fridayVars.length > 0) {
      pushObjectiveTerm(
        LinearExpr.sum(fridayVars),
        weights.normalizedWeights10k.friday,
        maxPenalties.friday
      );
    }
  }

  // --- Eq. (11): Active Days Penalty (Batching Subjects) P_days ---
  if (weights.normalizedWeights10k.days > 0 && maxPenalties.days > 0) {
    const activeDayVars: BoolVar[] = [];
    for (const day of WEEKDAYS) {
      const occs = problem.occurrencesByDay[day];
      if (occs.length === 0) continue;

      const uniqueNodeIndices = Array.from(new Set(occs.map((o) => o.nodeIndex)));
      const yDay = model.newBoolVar(`active_${day}`);

      // yDay === 1 <=> OR(x_v for v on day)
      model.addBoolOr(uniqueNodeIndices.map((idx) => xVars[idx])).onlyEnforceIf(yDay);
      for (const idx of uniqueNodeIndices) {
        model.addImplication(xVars[idx], yDay);
      }
      activeDayVars.push(yDay);
    }

    if (activeDayVars.length > 0) {
      pushObjectiveTerm(
        LinearExpr.sum(activeDayVars),
        weights.normalizedWeights10k.days,
        maxPenalties.days
      );
    }
  }

  // --- Eq. (12): Consecutive Hours Penalty (Fatigue Limit) P_fatigue ---
  if (weights.normalizedWeights10k.fatigue > 0 && maxPenalties.fatigue > 0) {
    const excessVars: IntVar[] = [];

    for (const day of WEEKDAYS) {
      const occs = problem.occurrencesByDay[day];
      if (occs.length === 0) continue;

      const maxRuns = computeMaxContinuousRunByOccurrence(problem, overlapSet, occs);
      const peakRun = maxRuns.reduce((m, v) => (v > m ? v : m), 0);
      if (peakRun <= fatigueThresholdMin) {
        continue;
      }

      const runEndVars: IntVar[] = occs.map((o, idx) =>
        model.newIntVar(0, maxRuns[idx], `run_${day}_${o.occurrenceIndex}`)
      );

      for (let i = 0; i < occs.length; i++) {
        const occ = occs[i];
        const xOcc = xVars[occ.nodeIndex];
        const runVar = runEndVars[i];

        // If occurrence is not selected, its continuous run is 0.
        model.addEquality(runVar, 0).onlyEnforceIf(xOcc.not());

        // Adjacent back-to-back predecessors (pred.end === occ.start, compatible with occ).
        const adjPreds: number[] = [];
        for (let p = 0; p < occs.length; p++) {
          if (p === i) continue;
          const pred = occs[p];
          if (pred.end !== occ.start) continue;
          if (nodesConflict(problem, overlapSet, pred.nodeIndex, occ.nodeIndex)) continue;
          adjPreds.push(p);
        }

        if (adjPreds.length === 0) {
          model.addEquality(runVar, occ.duration).onlyEnforceIf(xOcc);
        } else {
          const predNodes = Array.from(new Set(adjPreds.map((p) => occs[p].nodeIndex)));
          const hasPred = model.newBoolVar(`hasPred_${day}_${i}`);
          model.addBoolOr(predNodes.map((nIdx) => xVars[nIdx])).onlyEnforceIf(hasPred);
          for (const nIdx of predNodes) {
            model.addImplication(xVars[nIdx], hasPred);
          }

          // Start of a new continuous block (no adjacent predecessor selected)
          model.addEquality(runVar, occ.duration).onlyEnforceIf([xOcc, hasPred.not()]);

          // Continuation of a continuous block from unique selected adjacent predecessor
          for (const p of adjPreds) {
            const xPred = xVars[occs[p].nodeIndex];
            const guard: LiteralLike[] =
              occs[p].nodeIndex === occ.nodeIndex ? [xOcc] : [xOcc, xPred];
            model.addEquality(runVar, runEndVars[p].plus(occ.duration)).onlyEnforceIf(guard);
          }
        }

        // Only occurrences whose max possible run exceeds fatigueThresholdMin can incur fatigue.
        const maxExcess = maxRuns[i] - fatigueThresholdMin;
        if (maxExcess <= 0) {
          continue;
        }

        // Adjacent back-to-back successors (succ.start === occ.end, compatible with occ).
        const adjSuccNodes = Array.from(
          new Set(
            occs
              .filter(
                (succ, sIdx) =>
                  sIdx !== i &&
                  succ.start === occ.end &&
                  !nodesConflict(problem, overlapSet, occ.nodeIndex, succ.nodeIndex)
              )
              .map((succ) => succ.nodeIndex)
          )
        );

        // isBlockEnd === 1 <=> xOcc === 1 AND no adjacent successor is selected
        const isBlockEnd = model.newBoolVar(`blkEnd_${day}_${i}`);
        model.addImplication(isBlockEnd, xOcc);
        for (const sNode of adjSuccNodes) {
          model.addImplication(isBlockEnd, xVars[sNode].not());
        }
        model.addBoolOr([
          isBlockEnd,
          xOcc.not(),
          ...adjSuccNodes.map((sNode) => xVars[sNode]),
        ]);

        const clampedExcess = model.newIntVar(0, maxExcess, `clampFat_${day}_${i}`);
        model.addMaxEquality(clampedExcess, [0, runVar.minus(fatigueThresholdMin)]);

        const blockExcess = model.newIntVar(0, maxExcess, `blkFat_${day}_${i}`);
        model.addEquality(blockExcess, clampedExcess).onlyEnforceIf(isBlockEnd);
        model.addEquality(blockExcess, 0).onlyEnforceIf(isBlockEnd.not());
        excessVars.push(blockExcess);
      }
    }

    if (excessVars.length > 0) {
      pushObjectiveTerm(
        LinearExpr.sum(excessVars),
        weights.normalizedWeights10k.fatigue,
        maxPenalties.fatigue
      );
    }
  }

  // --- Eq. (13): Section Preference Penalty (Star) P_section ---
  if (
    problem.anyStarredSelectable &&
    weights.normalizedWeights10k.section > 0 &&
    maxPenalties.section > 0
  ) {
    const unstarredVars = problem.nodes
      .filter((n) => !n.isPreEnlisted && n.isExplicitOption && !n.flags.isStarred)
      .map((n) => xVars[n.nodeIndex]);
    if (unstarredVars.length > 0) {
      pushObjectiveTerm(
        LinearExpr.sum(unstarredVars),
        weights.normalizedWeights10k.section,
        maxPenalties.section
      );
    }
  }

  // --- Eq. (14): Excessive Gap Penalty P_gap (> 120 min between consecutive classes on day d) ---
  if (weights.normalizedWeights10k.gap > 0 && maxPenalties.gap > 0) {
    const gapVars: BoolVar[] = [];
    const gapWeights: number[] = [];

    for (const day of WEEKDAYS) {
      const occs = problem.occurrencesByDay[day];
      if (occs.length < 2) continue;

      for (let i = 0; i < occs.length; i++) {
        for (let j = i + 1; j < occs.length; j++) {
          const a = occs[i];
          const b = occs[j];
          const gapExcess = b.start - a.end - gapThresholdMin;
          if (gapExcess <= 0) continue;
          if (nodesConflict(problem, overlapSet, a.nodeIndex, b.nodeIndex)) continue;

          // Compatible occurrences strictly between a.end and b.start on day d
          const betweenNodeSet = new Set<number>();
          for (let k = 0; k < occs.length; k++) {
            if (k === i || k === j) continue;
            const mid = occs[k];
            if (mid.start >= a.end && mid.end <= b.start) {
              if (
                !nodesConflict(problem, overlapSet, a.nodeIndex, mid.nodeIndex) &&
                !nodesConflict(problem, overlapSet, b.nodeIndex, mid.nodeIndex)
              ) {
                betweenNodeSet.add(mid.nodeIndex);
              }
            }
          }

          // y_{i,j,d} === 1 <=> x_a === 1 AND x_b === 1 AND all between nodes === 0
          const yGap = model.newBoolVar(`gap_${day}_${i}_${j}`);
          const reqNodes = Array.from(new Set([a.nodeIndex, b.nodeIndex]));
          for (const rIdx of reqNodes) {
            model.addImplication(yGap, xVars[rIdx]);
          }
          const betweenNodes = Array.from(betweenNodeSet);
          for (const bIdx of betweenNodes) {
            model.addImplication(yGap, xVars[bIdx].not());
          }
          model.addBoolOr([
            yGap,
            ...reqNodes.map((rIdx) => xVars[rIdx].not()),
            ...betweenNodes.map((bIdx) => xVars[bIdx]),
          ]);

          gapVars.push(yGap);
          gapWeights.push(gapExcess);
        }
      }
    }

    if (gapVars.length > 0) {
      pushObjectiveTerm(
        LinearExpr.weightedSum(gapVars, gapWeights),
        weights.normalizedWeights10k.gap,
        maxPenalties.gap
      );
    }
  }

  // Eq. (15): Minimize composite integer-scaled objective Z
  if (objectiveTerms.length > 0) {
    model.minimize(LinearExpr.weightedSum(objectiveTerms, objectiveCoeffs));
  }

  return {
    model,
    xVars,
    weights,
    maxPenalties,
    triviallyInfeasible,
  };
}
