import {
  WEEKDAYS,
  type AcademicPlanState,
  type Weekday,
} from '../types/domain.ts';
import type {
  ForegroundConstraintRef,
  InfeasibilityDiagnosis,
  RelaxationAction,
} from '../types/solver.ts';
import {
  sectionDatesOverlap,
  sectionDatesOverlapBlockedCell,
  type PreprocessedProblem,
  type SolverSectionNode,
} from './preprocess.ts';

const SHORT_DAY_MAP: Record<Weekday, string> = {
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
  Friday: 'Fri',
  Saturday: 'Sat',
};

const FULL_DAY_START_MINUTES = 420; // 7:00 AM
const FULL_DAY_END_MINUTES = 1140;  // 7:00 PM

/**
 * Formats integer minutes since midnight into concise 12-hour display format
 * matching Paper Files/2.0.png (e.g., 780 -> "1:00 PM", 960 -> "4:00 PM").
 */
export function formatMinutesDisplay(minutes: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(minutes)));
  const h24 = Math.floor(clamped / 60);
  const m = clamped % 60;
  const meridiem = h24 >= 12 && h24 < 24 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${meridiem}`;
}

export function formatTimeRange(startMinutes: number, endMinutes: number): string {
  return `${formatMinutesDisplay(startMinutes)} - ${formatMinutesDisplay(endMinutes)}`;
}

/**
 * Formats unique weekdays in canonical Mon–Sat order joined by "/" (e.g., "Tue/Thu").
 */
export function formatDaySummary(days: readonly Weekday[]): string {
  const unique = new Set(days);
  const ordered = WEEKDAYS.filter((d) => unique.has(d));
  return ordered.map((d) => SHORT_DAY_MAP[d]).join('/');
}

type TimeBlockRef = Extract<ForegroundConstraintRef, { kind: 'TIME_BLOCK' }>;
type IntendedCourseRef = Extract<ForegroundConstraintRef, { kind: 'INTENDED_COURSE' }>;
type HiddenSectionRef = Extract<ForegroundConstraintRef, { kind: 'HIDDEN_SECTION' }>;
type LockedSectionRef = Extract<ForegroundConstraintRef, { kind: 'USER_LOCKED_SECTION' }>;

function isFullDayBlock(block: TimeBlockRef): boolean {
  return (
    block.startMinutes <= FULL_DAY_START_MINUTES &&
    block.endMinutes >= FULL_DAY_END_MINUTES
  );
}

/**
 * Formats one or more conflicting time-block windows into a concise relaxation range.
 * When all blocks share identical start/end bounds (e.g., Tue 1-4 PM and Thu 1-4 PM in 2.0.png),
 * returns the unified range "1:00 PM - 4:00 PM".
 */
export function formatMergedTimeWindowSummary(blocks: readonly TimeBlockRef[]): string {
  if (blocks.length === 0) return '';

  const sorted = [...blocks].sort((a, b) => {
    const dayDiff = WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day);
    if (dayDiff !== 0) return dayDiff;
    return a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes;
  });

  const firstStart = sorted[0].startMinutes;
  const firstEnd = sorted[0].endMinutes;
  const allSameBounds = sorted.every(
    (b) => b.startMinutes === firstStart && b.endMinutes === firstEnd
  );

  if (allSameBounds) {
    if (sorted.length === 1 && isFullDayBlock(sorted[0])) {
      return `${sorted[0].day} (${formatTimeRange(firstStart, firstEnd)})`;
    }
    return formatTimeRange(firstStart, firstEnd);
  }

  return sorted
    .map((b) => `${SHORT_DAY_MAP[b.day]} ${formatTimeRange(b.startMinutes, b.endMinutes)}`)
    .join(' or ');
}

function formatNaturalList(items: readonly string[], conjunction: 'and' | 'or' = 'and'): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items[items.length - 1]}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((v) => v.length > 0)));
}

function findOverlappingPreEnlistedAnchors(
  problem: PreprocessedProblem,
  courseId: string
): SolverSectionNode[] {
  const preNodes = problem.nodes.filter((n) => n.isPreEnlisted);
  if (preNodes.length === 0) return [];

  const courseNodes = problem.nodes.filter(
    (n) => n.courseId === courseId && !n.isPreEnlisted
  );
  const overlapping = new Map<string, SolverSectionNode>();

  for (const pre of preNodes) {
    for (const cand of courseNodes) {
      if (sectionDatesOverlap(pre.dates, cand.dates)) {
        overlapping.set(`${pre.courseId}::${pre.sectionId}`, pre);
      }
    }
  }

  return Array.from(overlapping.values());
}

function findPreEnlistedOverlappingBlocks(
  problem: PreprocessedProblem,
  blocks: readonly TimeBlockRef[]
): SolverSectionNode[] {
  const preNodes = problem.nodes.filter((n) => n.isPreEnlisted);
  const overlapping = new Map<string, SolverSectionNode>();

  for (const pre of preNodes) {
    for (const block of blocks) {
      if (
        sectionDatesOverlapBlockedCell(pre.dates, {
          id: block.blockId,
          day: block.day,
          startMinutes: block.startMinutes,
          endMinutes: block.endMinutes,
        })
      ) {
        overlapping.set(`${pre.courseId}::${pre.sectionId}`, pre);
      }
    }
  }

  return Array.from(overlapping.values());
}

function checkUnitLimitOverflow(
  problem: PreprocessedProblem,
  intendedCourseIds: readonly string[]
): { exceeded: boolean; maxUnits: number | null; combinedUnits: number } {
  const maxUnits = problem.unitLimits?.maxUnits;
  if (typeof maxUnits !== 'number' || !Number.isFinite(maxUnits)) {
    return { exceeded: false, maxUnits: null, combinedUnits: 0 };
  }

  let preUnits = 0;
  for (const c of problem.courses) {
    if (c.isPreEnlistedCourse) {
      preUnits += c.units;
    }
  }

  const idSet = new Set(intendedCourseIds);
  let intendedUnits = 0;
  for (const c of problem.courses) {
    if (!c.isPreEnlistedCourse && idSet.has(c.courseId)) {
      intendedUnits += c.units;
    }
  }

  const combinedUnits = Number((preUnits + intendedUnits).toFixed(2));
  return {
    exceeded: combinedUnits > maxUnits + 1e-6,
    maxUnits,
    combinedUnits,
  };
}

/**
 * Builds deterministic structured relaxation actions from an extracted MUS, ordered from
 * least disruptive (unhide section -> unblock time window -> unlock section) to most
 * disruptive (drop/replace intended course).
 */
export function buildRelaxationActionsFromMus(
  mus: readonly ForegroundConstraintRef[]
): RelaxationAction[] {
  const actions: RelaxationAction[] = [];

  const hiddenRefs = mus.filter((r): r is HiddenSectionRef => r.kind === 'HIDDEN_SECTION');
  const blockRefs = mus.filter((r): r is TimeBlockRef => r.kind === 'TIME_BLOCK');
  const lockRefs = mus.filter((r): r is LockedSectionRef => r.kind === 'USER_LOCKED_SECTION');
  const courseRefs = mus.filter((r): r is IntendedCourseRef => r.kind === 'INTENDED_COURSE');

  for (const ref of hiddenRefs) {
    actions.push({
      id: `unhide:${ref.sectionId}`,
      label: `Unhide ${ref.courseCode} (${ref.sectionName})`,
      description: `Restore hidden section ${ref.sectionName} of ${ref.courseCode} as a selectable option.`,
      relaxedConstraints: [ref],
      actionType: 'UNHIDE_SECTION',
    });
  }

  for (const ref of blockRefs) {
    const windowStr = `${SHORT_DAY_MAP[ref.day]} ${formatTimeRange(ref.startMinutes, ref.endMinutes)}`;
    actions.push({
      id: `unblock:${ref.blockId}`,
      label: `Unblock ${windowStr}`,
      description: isFullDayBlock(ref)
        ? `Allow classes on ${ref.day} by removing the full-day block (${formatTimeRange(ref.startMinutes, ref.endMinutes)}).`
        : `Remove blocked hours on ${windowStr} so compatible sections can be scheduled.`,
      relaxedConstraints: [ref],
      actionType: 'UNBLOCK_TIME_WINDOW',
    });
  }

  for (const ref of lockRefs) {
    actions.push({
      id: `unlock:${ref.sectionId}`,
      label: `Unlock ${ref.courseCode} (${ref.sectionName})`,
      description: `Release the manual lock on ${ref.courseCode} (${ref.sectionName}) so the solver can select another section.`,
      relaxedConstraints: [ref],
      actionType: 'UNLOCK_SECTION',
    });
  }

  for (const ref of courseRefs) {
    actions.push({
      id: `drop:${ref.courseId}`,
      label: `Drop or replace ${ref.courseCode}`,
      description: `Remove ${ref.courseCode} from this schedule plan or substitute an alternative course.`,
      relaxedConstraints: [ref],
      actionType: 'DROP_OR_REPLACE_COURSE',
    });
  }

  return actions;
}

/**
 * Pure immutable helper that applies a RelaxationAction to a cloned AcademicPlanState
 * so callers (fallback generator, HITL UI, tests) can verify feasibility after relaxation.
 */
export function applyRelaxationToPlan(
  plan: AcademicPlanState,
  action: RelaxationAction
): AcademicPlanState {
  const relaxedBlocks = action.relaxedConstraints.filter(
    (c): c is TimeBlockRef => c.kind === 'TIME_BLOCK'
  );
  const unhideIds = new Set(
    action.relaxedConstraints
      .filter((c): c is HiddenSectionRef => c.kind === 'HIDDEN_SECTION')
      .map((c) => c.sectionId)
  );
  const unlockIds = new Set(
    action.relaxedConstraints
      .filter((c): c is LockedSectionRef => c.kind === 'USER_LOCKED_SECTION')
      .map((c) => c.sectionId)
  );
  const dropCourseIds = new Set(
    action.relaxedConstraints
      .filter((c): c is IntendedCourseRef => c.kind === 'INTENDED_COURSE')
      .map((c) => c.courseId)
  );

  const nextBlockedCells = plan.blockedCells.filter((cell) => {
    for (const blk of relaxedBlocks) {
      if (
        cell.day === blk.day &&
        cell.startMinutes < blk.endMinutes &&
        blk.startMinutes < cell.endMinutes
      ) {
        return false;
      }
    }
    return true;
  });

  const nextIntendedCourses = plan.intendedCourses
    .filter((course) => !dropCourseIds.has(course.id))
    .map((course) => ({
      ...course,
      sections: course.sections.map((opt) => ({
        ...opt,
        flags: {
          ...opt.flags,
          isHidden: unhideIds.has(opt.section.id) ? false : opt.flags.isHidden,
          isLocked: unlockIds.has(opt.section.id) ? false : opt.flags.isLocked,
        },
      })),
    }));

  return {
    ...plan,
    blockedCells: nextBlockedCells,
    intendedCourses: nextIntendedCourses,
  };
}

/**
 * Tier 2 diagnosis builder: Exhausted Capacity (SPEC.md Section 6.2 & 6.4).
 */
export function buildExhaustedCapacityDiagnosis(
  problem: PreprocessedProblem
): InfeasibilityDiagnosis {
  const affectedCourseCodes = uniqueStrings(
    problem.exhaustedCourses.map((c) => c.courseCode)
  );
  return {
    origin: 'EXHAUSTED_CAPACITY',
    mus: [],
    hardClashCount: problem.exhaustedCourses.length,
    conflictSummaryBullets: problem.exhaustedCourses.map(
      (c) => `Unavailable course: ${c.courseCode} currently has 0 open slots across all sections.`
    ),
    relaxationSuggestions: [
      'Search for an alternative course or refresh AMIS section data later.',
    ],
    affectedCourseCodes,
    relaxationActions: problem.exhaustedCourses.map((c) => ({
      id: `drop:${c.courseId}`,
      label: `Replace unavailable course ${c.courseCode}`,
      description: `${c.courseCode} currently has 0 open non-TBA sections.`,
      relaxedConstraints: [
        {
          kind: 'INTENDED_COURSE',
          courseId: c.courseId,
          courseCode: c.courseCode,
          priorityWeight: 100,
        },
      ],
      actionType: 'DROP_OR_REPLACE_COURSE',
    })),
    fallbackOptions: [],
    isStructuralConflict: true,
  };
}

/**
 * Tier 1 diagnosis builder: Background Set B Data Inconsistency (SPEC.md Section 6.2).
 */
export function buildDataInconsistencyDiagnosis(
  problem: PreprocessedProblem
): InfeasibilityDiagnosis {
  const bullets: string[] = [];
  const suggestions: string[] = [];
  const affectedCodes: string[] = [];

  // 1. Check overlapping pre-enlisted sections
  const preNodes = problem.nodes.filter((n) => n.isPreEnlisted);
  const seenPairs = new Set<string>();
  for (let i = 0; i < preNodes.length; i++) {
    for (let j = i + 1; j < preNodes.length; j++) {
      const a = preNodes[i];
      const b = preNodes[j];
      if (sectionDatesOverlap(a.dates, b.dates)) {
        const pairKey = [a.varKey, b.varKey].sort().join('|');
        if (!seenPairs.has(pairKey)) {
          seenPairs.add(pairKey);
          affectedCodes.push(a.courseCode, b.courseCode);
          bullets.push(
            `Foundational data conflict: Pre-enlisted sections ${a.courseCode} (${a.sectionName}) and ${b.courseCode} (${b.sectionName}) overlap in schedule.`
          );
        }
      }
    }
  }

  // 2. Check pre-enlisted courses with missing required components or broken parent-child links
  for (const course of problem.courses) {
    if (!course.isPreEnlistedCourse) continue;
    for (const comp of course.requiredComponents) {
      const indices = course.nodeIndicesByComponent.get(comp) ?? [];
      if (indices.length === 0) {
        affectedCodes.push(course.courseCode);
        bullets.push(
          `Foundational data conflict: Pre-enlisted course ${course.courseCode} is missing valid schedule data for component ${comp}.`
        );
      }
    }
    for (const group of course.linkageGroups) {
      const parent = problem.nodes[group.parentNodeIndex];
      if (parent.isPreEnlisted && group.childNodeIndices.length === 0) {
        affectedCodes.push(course.courseCode);
        bullets.push(
          `Foundational data conflict: Pre-enlisted lecture ${course.courseCode} (${parent.sectionName}) has no valid ${group.childComponent} section.`
        );
      }
    }
  }

  // 3. Check impossible unit limits in Background Set B
  if (problem.unitLimits) {
    const { minUnits, maxUnits } = problem.unitLimits;
    if (
      typeof minUnits === 'number' &&
      typeof maxUnits === 'number' &&
      minUnits > maxUnits
    ) {
      bullets.push(
        `Unit limit inconsistency: Minimum required units (${minUnits}) exceed maximum allowed units (${maxUnits}).`
      );
      suggestions.push('Adjust your minimum and maximum unit limits so minUnits <= maxUnits.');
    } else if (typeof minUnits === 'number' && problem.totalUnits < minUnits - 1e-6) {
      bullets.push(
        `Unit limit inconsistency: Total units across all selected courses (${problem.totalUnits}) is below the minimum required ${minUnits} units.`
      );
      suggestions.push('Add more courses or lower the minimum unit requirement.');
    } else if (typeof maxUnits === 'number') {
      const preUnits = problem.courses
        .filter((c) => c.isPreEnlistedCourse)
        .reduce((sum, c) => sum + c.units, 0);
      if (preUnits > maxUnits + 1e-6) {
        bullets.push(
          `Unit limit inconsistency: Pre-enlisted courses alone total ${preUnits} units, exceeding the maximum limit of ${maxUnits} units.`
        );
        suggestions.push('Increase the maximum unit limit to accommodate pre-enlisted courses.');
      }
    }
  }

  if (bullets.length === 0) {
    bullets.push(
      'Foundational data conflict: Your locked pre-enlisted courses or structural unit requirements cannot be simultaneously satisfied.'
    );
  }
  if (suggestions.length === 0) {
    suggestions.push(
      'Verify your pre-enlisted classes on UPLB AMIS or refresh your course data.'
    );
  }

  return {
    origin: 'DATA_INCONSISTENCY',
    mus: [],
    hardClashCount: Math.max(1, bullets.length),
    conflictSummaryBullets: bullets,
    relaxationSuggestions: suggestions,
    affectedCourseCodes: uniqueStrings(affectedCodes),
    relaxationActions: [],
    fallbackOptions: [],
    isStructuralConflict: true,
  };
}

/**
 * WASM Sandbox / Timeout Fallback diagnosis builder (SPEC.md Section 6.3 & 6.4).
 */
export function buildResourceFallbackDiagnosis(): InfeasibilityDiagnosis {
  return {
    origin: 'SOLVER_RESOURCE_FALLBACK',
    mus: [],
    hardClashCount: 1,
    conflictSummaryBullets: [
      'Model infeasible: Unable to isolate a minimal conflict set within browser memory/time limits.',
    ],
    relaxationSuggestions: [
      'Manually remove blocked time slots or deselect a course to restore feasibility.',
    ],
    affectedCourseCodes: [],
    relaxationActions: [],
    fallbackOptions: [],
    isStructuralConflict: false,
  };
}

/**
 * Deterministic natural-language explanation mapper translating an extracted MUS
 * into structured conflict summary bullets, actionable relaxation suggestions,
 * affected course code chips, and relaxation action descriptors (SPEC.md Section 6.4).
 */
export function mapMusToDiagnosis(
  problem: PreprocessedProblem,
  mus: readonly ForegroundConstraintRef[]
): InfeasibilityDiagnosis {
  const courseRefs = mus.filter((r): r is IntendedCourseRef => r.kind === 'INTENDED_COURSE');
  const blockRefs = mus.filter((r): r is TimeBlockRef => r.kind === 'TIME_BLOCK');
  const hiddenRefs = mus.filter((r): r is HiddenSectionRef => r.kind === 'HIDDEN_SECTION');
  const lockRefs = mus.filter((r): r is LockedSectionRef => r.kind === 'USER_LOCKED_SECTION');

  const affectedCourseCodes = uniqueStrings([
    ...courseRefs.map((c) => c.courseCode),
    ...hiddenRefs.map((h) => h.courseCode),
    ...lockRefs.map((l) => l.courseCode),
  ]);

  const conflictSummaryBullets: string[] = [];
  const relaxationSuggestions: string[] = [];

  const isStructuralConflict =
    mus.length > 0 &&
    blockRefs.length === 0 &&
    hiddenRefs.length === 0 &&
    lockRefs.length === 0 &&
    courseRefs.length > 0;

  // Pattern 1: Time-Block(s) + Intended Course(s) — exact pattern from Paper Files/2.0.png
  if (
    blockRefs.length > 0 &&
    courseRefs.length > 0 &&
    hiddenRefs.length === 0 &&
    lockRefs.length === 0
  ) {
    const daySummary = formatDaySummary(blockRefs.map((b) => b.day));
    const mergedRange = formatMergedTimeWindowSummary(blockRefs);
    const courseLabel = formatNaturalList(courseRefs.map((c) => c.courseCode));

    conflictSummaryBullets.push(
      `${daySummary} block conflict: Your blocked hours on ${daySummary} clash directly with the only available sections of ${courseLabel}.`
    );
    relaxationSuggestions.push(
      `Consider unblocking ${mergedRange} or searching for alternative elective courses.`
    );
  }
  // Pattern 2: Single Intended Course vs Pre-Enlisted Anchor / Unit Limit (no blocks, hides, or locks)
  else if (
    courseRefs.length === 1 &&
    blockRefs.length === 0 &&
    hiddenRefs.length === 0 &&
    lockRefs.length === 0
  ) {
    const target = courseRefs[0];
    const preAnchors = findOverlappingPreEnlistedAnchors(problem, target.courseId);
    const unitOverflow = checkUnitLimitOverflow(problem, [target.courseId]);

    if (preAnchors.length > 0) {
      const primary = preAnchors[0];
      if (!affectedCourseCodes.includes(primary.courseCode)) {
        affectedCourseCodes.push(primary.courseCode);
      }
      conflictSummaryBullets.push(
        `Pre-enlisted lock conflict: Your locked course ${primary.courseCode} (${primary.sectionName}) overlaps with all available sections of ${target.courseCode}.`
      );
      relaxationSuggestions.push(
        `Consider searching for an alternative course to replace ${target.courseCode}.`
      );
    } else if (unitOverflow.exceeded && unitOverflow.maxUnits !== null) {
      conflictSummaryBullets.push(
        `Unit limit conflict: Adding ${target.courseCode} (${unitOverflow.combinedUnits} total units) exceeds your maximum allowed limit of ${unitOverflow.maxUnits} units.`
      );
      relaxationSuggestions.push(
        `Consider replacing ${target.courseCode} with a lower-unit course or increasing your maximum unit limit.`
      );
    } else {
      conflictSummaryBullets.push(
        `Course overlap conflict: ${target.courseCode} has no conflict-free valid section combination with your pre-enlisted schedule.`
      );
      relaxationSuggestions.push(
        `Consider searching for an alternative course to replace ${target.courseCode}.`
      );
    }
  }
  // Pattern 3: Two or more Intended Courses clashing structurally (or exceeding maxUnits)
  else if (
    courseRefs.length >= 2 &&
    blockRefs.length === 0 &&
    hiddenRefs.length === 0 &&
    lockRefs.length === 0
  ) {
    const courseCodes = courseRefs.map((c) => c.courseCode);
    const courseList = formatNaturalList(courseCodes);
    const unitOverflow = checkUnitLimitOverflow(
      problem,
      courseRefs.map((c) => c.courseId)
    );

    if (unitOverflow.exceeded && unitOverflow.maxUnits !== null) {
      conflictSummaryBullets.push(
        `Unit limit conflict: Combining ${courseList} (${unitOverflow.combinedUnits} units) exceeds your maximum allowed limit of ${unitOverflow.maxUnits} units.`
      );
      relaxationSuggestions.push(
        `Consider dropping one of ${courseList} or increasing your maximum unit limit.`
      );
    } else if (courseCodes.length === 2) {
      conflictSummaryBullets.push(
        `Course overlap conflict: All available sections of ${courseCodes[0]} clash directly with ${courseCodes[1]}.`
      );
      relaxationSuggestions.push(
        `Consider replacing one of ${courseList} with an alternative course or relaxing hidden sections.`
      );
    } else {
      conflictSummaryBullets.push(
        `Course overlap conflict: Available sections across ${courseList} mutually clash with no conflict-free assignment.`
      );
      relaxationSuggestions.push(
        `Consider replacing one of ${courseList} with an alternative course or relaxing hidden sections.`
      );
    }
  }
  // Pattern 4: Hidden Section(s) (+ Intended Course / Time Blocks, without user locks)
  else if (hiddenRefs.length > 0 && lockRefs.length === 0) {
    const hiddenCourseCodes = uniqueStrings(hiddenRefs.map((h) => h.courseCode));
    const hiddenCourseLabel = formatNaturalList(hiddenCourseCodes);
    const hiddenSectionLabels = hiddenRefs.map((h) => `${h.courseCode} (${h.sectionName})`);

    if (blockRefs.length > 0) {
      const daySummary = formatDaySummary(blockRefs.map((b) => b.day));
      const mergedRange = formatMergedTimeWindowSummary(blockRefs);
      conflictSummaryBullets.push(
        `Section exclusion & ${daySummary} block conflict: Hiding ${formatNaturalList(hiddenSectionLabels)} alongside your blocked hours on ${daySummary} leaves no conflict-free schedule.`
      );
      relaxationSuggestions.push(
        `Consider unhiding excluded sections of ${hiddenCourseLabel} or unblocking ${mergedRange}.`
      );
    } else {
      conflictSummaryBullets.push(
        `Section exclusion conflict: Hiding sections of ${hiddenCourseLabel} (${formatNaturalList(hiddenSectionLabels)}) leaves no conflict-free schedule with your remaining courses.`
      );
      relaxationSuggestions.push(
        `Consider unhiding excluded sections of ${hiddenCourseLabel} or relaxing blocked time slots.`
      );
    }
  }
  // Pattern 5: User-Locked Section(s) conflicts
  else if (lockRefs.length > 0) {
    const lockLabels = lockRefs.map((l) => `${l.courseCode} (${l.sectionName})`);
    const lockList = formatNaturalList(lockLabels);

    if (hiddenRefs.length > 0) {
      const hiddenLabels = hiddenRefs.map((h) => `${h.courseCode} (${h.sectionName})`);
      conflictSummaryBullets.push(
        `Locked & hidden section conflict: Locked ${lockList} conflicts directly with hidden ${formatNaturalList(hiddenLabels)}.`
      );
      relaxationSuggestions.push(
        `Consider unlocking ${lockList} or unhiding ${formatNaturalList(hiddenLabels)}.`
      );
    } else if (blockRefs.length > 0) {
      const daySummary = formatDaySummary(blockRefs.map((b) => b.day));
      const mergedRange = formatMergedTimeWindowSummary(blockRefs);
      const extraCourses = courseRefs
        .map((c) => c.courseCode)
        .filter((code) => !lockRefs.some((l) => l.courseCode === code));

      if (extraCourses.length > 0) {
        conflictSummaryBullets.push(
          `Locked section & ${daySummary} block conflict: Locked ${lockList} combined with blocked hours on ${daySummary} (${mergedRange}) leaves no valid sections for ${formatNaturalList(extraCourses)}.`
        );
      } else {
        conflictSummaryBullets.push(
          `Locked section & ${daySummary} block conflict: Your locked section ${lockList} clashes with your blocked hours on ${daySummary} (${mergedRange}).`
        );
      }
      relaxationSuggestions.push(
        `Consider unlocking ${lockList} or unblocking ${mergedRange}.`
      );
    } else if (lockRefs.length >= 2) {
      conflictSummaryBullets.push(
        `Locked sections conflict: Your locked sections ${lockList} overlap in schedule or belong to the same course component.`
      );
      relaxationSuggestions.push(
        `Consider unlocking at least one of ${lockList} to allow alternative sections.`
      );
    } else if (courseRefs.length > 0) {
      const otherCourses = courseRefs
        .map((c) => c.courseCode)
        .filter((code) => !lockRefs.some((l) => l.courseCode === code));
      const targetLabel =
        otherCourses.length > 0
          ? formatNaturalList(otherCourses)
          : formatNaturalList(courseRefs.map((c) => c.courseCode));
      conflictSummaryBullets.push(
        `Locked section conflict: Your locked section ${lockList} overlaps with all available sections of ${targetLabel}.`
      );
      relaxationSuggestions.push(
        `Consider unlocking ${lockList} or searching for an alternative course.`
      );
    } else {
      // Single locked section clashing with a pre-enlisted course in Background Set B
      const preAnchors = findOverlappingPreEnlistedAnchors(problem, lockRefs[0].courseId);
      if (preAnchors.length > 0) {
        const pre = preAnchors[0];
        if (!affectedCourseCodes.includes(pre.courseCode)) {
          affectedCourseCodes.push(pre.courseCode);
        }
        conflictSummaryBullets.push(
          `Locked section conflict: Your locked section ${lockList} overlaps with your pre-enlisted course ${pre.courseCode} (${pre.sectionName}).`
        );
      } else {
        conflictSummaryBullets.push(
          `Locked section conflict: Your locked section ${lockList} cannot be satisfied alongside your fixed schedule constraints.`
        );
      }
      relaxationSuggestions.push(
        `Consider unlocking ${lockList} to allow alternative sections.`
      );
    }
  }
  // Pattern 6: Time-Block(s) alone (clashing with pre-enlisted anchors or minUnits in B)
  else if (blockRefs.length > 0) {
    const daySummary = formatDaySummary(blockRefs.map((b) => b.day));
    const mergedRange = formatMergedTimeWindowSummary(blockRefs);
    const preAnchors = findPreEnlistedOverlappingBlocks(problem, blockRefs);

    if (preAnchors.length > 0) {
      const pre = preAnchors[0];
      if (!affectedCourseCodes.includes(pre.courseCode)) {
        affectedCourseCodes.push(pre.courseCode);
      }
      conflictSummaryBullets.push(
        `${daySummary} block conflict: Your blocked hours on ${daySummary} (${mergedRange}) clash directly with your pre-enlisted course ${pre.courseCode} (${pre.sectionName}).`
      );
      relaxationSuggestions.push(
        `Consider unblocking ${mergedRange} since pre-enlisted courses cannot be moved.`
      );
    } else {
      conflictSummaryBullets.push(
        `${daySummary} block conflict: Your blocked hours on ${daySummary} (${mergedRange}) prevent satisfying your required schedule constraints.`
      );
      relaxationSuggestions.push(
        `Consider unblocking ${mergedRange} or adjusting your course selection.`
      );
    }
  } else {
    conflictSummaryBullets.push(
      'Schedule conflict detected: Selected constraints cannot be simultaneously satisfied.'
    );
    relaxationSuggestions.push(
      'Relax one of your blocked time windows, locked sections, or intended courses.'
    );
  }

  const relaxationActions = buildRelaxationActionsFromMus(mus);

  return {
    origin: 'PREFERENCE_CONFLICT',
    mus: [...mus],
    hardClashCount: 1,
    conflictSummaryBullets,
    relaxationSuggestions,
    affectedCourseCodes,
    relaxationActions,
    fallbackOptions: [],
    isStructuralConflict,
  };
}
