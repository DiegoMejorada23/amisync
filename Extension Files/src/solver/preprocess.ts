import {
  DEFAULT_COMPONENT_TYPE,
  hasAvailableCapacity,
  hasFixedSchedule,
  isStandardComponentType,
  normalizeComponentType,
  normalizeCourseCodeKey,
  SUBCOMPONENT_TYPE,
} from '../amis/parser.ts';
import {
  WEEKDAYS,
  type AcademicPlanState,
  type BlockedTimeCell,
  type ComponentType,
  type CourseEntry,
  type CourseSectionOption,
  type NormalizedSection,
  type SectionUserFlags,
  type TimeslotInterval,
  type UnitLimitsConfig,
  type Weekday,
} from '../types/domain.ts';

export { DEFAULT_COMPONENT_TYPE, normalizeComponentType, normalizeCourseCodeKey };

export interface SolverSectionNode {
  nodeIndex: number;
  varKey: string;
  courseKey: string;
  courseId: string;
  courseCode: string;
  sectionId: string;
  sectionName: string;
  component: ComponentType;
  dates: TimeslotInterval[];
  parentSectionId: string | null;
  parentNodeIndex: number | null;
  isPreEnlisted: boolean;
  isExplicitOption: boolean;
  flags: SectionUserFlags;
  meetsOnFriday: boolean;
  activeClassSize: number;
  maxClassSize: number;
}

export interface ParentChildLinkageGroup {
  courseKey: string;
  parentNodeIndex: number;
  childComponent: ComponentType;
  childNodeIndices: number[];
}

export interface PreprocessedCourse {
  courseKey: string;
  courseId: string;
  courseCode: string;
  units: number;
  isPreEnlistedCourse: boolean;
  requiredComponents: ComponentType[];
  nodeIndicesByComponent: Map<ComponentType, number[]>;
  linkageGroups: ParentChildLinkageGroup[];
}

export interface DayOccurrence {
  occurrenceIndex: number;
  nodeIndex: number;
  day: Weekday;
  start: number;
  end: number;
  duration: number;
}

export interface ExhaustedCourseInfo {
  courseKey: string;
  courseId: string;
  courseCode: string;
  reason: string;
}

export interface PreprocessedProblem {
  courses: PreprocessedCourse[];
  nodes: SolverSectionNode[];
  nodeIndexByCourseAndSectionId: Map<string, number>;
  occurrencesByDay: Record<Weekday, DayOccurrence[]>;
  overlappingPairs: Array<[number, number]>;
  blockedNodeIndices: Set<number>;
  exhaustedCourses: ExhaustedCourseInfo[];
  flexibleNodeIndices: number[];
  anyStarredSelectable: boolean;
  totalUnits: number;
  unitLimits: UnitLimitsConfig | null;
}

/**
 * Exact temporal overlap check per SPEC.md Eq. (4):
 * Two intervals sharing at least one weekday overlap iff start_i < end_j && start_j < end_i.
 * Adjacent intervals (end_i === start_j) strictly do NOT overlap.
 */
export function timeslotIntervalsOverlap(a: TimeslotInterval, b: TimeslotInterval): boolean {
  if (a.startMinutes >= b.endMinutes || b.startMinutes >= a.endMinutes) {
    return false;
  }
  for (const day of a.days) {
    if (b.days.includes(day)) {
      return true;
    }
  }
  return false;
}

export function sectionDatesOverlap(a: readonly TimeslotInterval[], b: readonly TimeslotInterval[]): boolean {
  for (const ia of a) {
    for (const ib of b) {
      if (timeslotIntervalsOverlap(ia, ib)) {
        return true;
      }
    }
  }
  return false;
}

export function sectionDatesOverlapBlockedCell(
  dates: readonly TimeslotInterval[],
  cell: BlockedTimeCell
): boolean {
  for (const interval of dates) {
    if (!interval.days.includes(cell.day)) {
      continue;
    }
    if (interval.startMinutes < cell.endMinutes && cell.startMinutes < interval.endMinutes) {
      return true;
    }
  }
  return false;
}

interface RawNodeAccumulator {
  section: NormalizedSection;
  component: ComponentType;
  parentSectionId: string | null;
  isPreEnlisted: boolean;
  isExplicitOption: boolean;
  flags: SectionUserFlags;
}

function resolveEffectiveTermId(plan: AcademicPlanState): number | null {
  if (typeof plan.termId === 'number' && Number.isFinite(plan.termId)) {
    return plan.termId;
  }
  for (const course of [...plan.preEnlistedCourses, ...plan.intendedCourses]) {
    if (typeof course.termId === 'number' && Number.isFinite(course.termId)) {
      return course.termId;
    }
    for (const opt of course.sections) {
      if (typeof opt.section.termId === 'number' && Number.isFinite(opt.section.termId)) {
        return opt.section.termId;
      }
      if (
        opt.section.parentClass &&
        typeof opt.section.parentClass.termId === 'number' &&
        Number.isFinite(opt.section.parentClass.termId)
      ) {
        return opt.section.parentClass.termId;
      }
    }
  }
  return null;
}

function sectionChainMatchesTerm(section: NormalizedSection, effectiveTermId: number | null): boolean {
  if (effectiveTermId === null) {
    return true;
  }
  if (typeof section.termId === 'number' && section.termId !== effectiveTermId) {
    return false;
  }
  if (section.parentClass && !sectionChainMatchesTerm(section.parentClass, effectiveTermId)) {
    return false;
  }
  return true;
}

function collectCourseNodesFromOption(
  option: CourseSectionOption,
  courseIsPreEnlisted: boolean,
  accMap: Map<string, RawNodeAccumulator>,
  effectiveTermId: number | null
): void {
  if (!sectionChainMatchesTerm(option.section, effectiveTermId)) {
    return;
  }
  const leafPreEnlisted = courseIsPreEnlisted || option.isPreEnlisted;

  const upsertSection = (
    sec: NormalizedSection,
    isLeaf: boolean,
    inheritedPreEnlisted: boolean
  ): void => {
    if (sec.parentClass) {
      upsertSection(sec.parentClass, false, inheritedPreEnlisted);
    }

    const parentSectionId = sec.parentClass?.id ?? sec.parentClassId ?? null;
    const component = normalizeComponentType(sec.activity);
    const existing = accMap.get(sec.id);

    if (!existing) {
      accMap.set(sec.id, {
        section: sec,
        component,
        parentSectionId,
        isPreEnlisted: inheritedPreEnlisted,
        isExplicitOption: isLeaf,
        flags: isLeaf
          ? {
              isHidden: Boolean(option.flags.isHidden),
              isLocked: Boolean(option.flags.isLocked),
              isStarred: Boolean(option.flags.isStarred),
            }
          : {
              isHidden: false,
              isLocked: false,
              isStarred: false,
            },
      });
      return;
    }

    // Merge metadata when the same section appears both as a nested parentClass and as an explicit option.
    existing.isPreEnlisted = existing.isPreEnlisted || inheritedPreEnlisted;
    if (!existing.parentSectionId && parentSectionId) {
      existing.parentSectionId = parentSectionId;
    }
    if (isLeaf) {
      existing.isExplicitOption = true;
      existing.flags.isHidden = existing.flags.isHidden || Boolean(option.flags.isHidden);
      existing.flags.isLocked = existing.flags.isLocked || Boolean(option.flags.isLocked);
      existing.flags.isStarred = existing.flags.isStarred || Boolean(option.flags.isStarred);
    }
  };

  upsertSection(option.section, true, leafPreEnlisted);
}

/**
 * Merges pre-enlisted and intended course entries sharing the same normalized course code
 * or course ID (including multi-topic courses such as CMSC 191, partial pre-enlistment,
 * and duplicate course entries) so all sections of a course share one constraint group.
 * Enforces cross-term isolation by excluding courses or sections tagged with a different `termId`.
 */
function mergeCourseEntries(
  preEnlistedCourses: CourseEntry[],
  intendedCourses: CourseEntry[],
  effectiveTermId: number | null
): Array<{
  courseKey: string;
  courseId: string;
  courseCode: string;
  units: number;
  isPreEnlistedCourse: boolean;
  rawRequiredComponents: ComponentType[];
  accMap: Map<string, RawNodeAccumulator>;
}> {
  const merged: Array<{
    courseKey: string;
    courseId: string;
    courseCode: string;
    units: number;
    isPreEnlistedCourse: boolean;
    rawRequiredComponents: Set<ComponentType>;
    accMap: Map<string, RawNodeAccumulator>;
  }> = [];

  const byCourseCode = new Map<string, (typeof merged)[number]>();
  const byCourseId = new Map<string, (typeof merged)[number]>();

  const addCourse = (course: CourseEntry, fromPreEnlistedList: boolean) => {
    if (
      effectiveTermId !== null &&
      typeof course.termId === 'number' &&
      course.termId !== effectiveTermId
    ) {
      return;
    }

    const courseIsPre = fromPreEnlistedList || course.isPreEnlisted;
    const normalizedCode = normalizeCourseCodeKey(course.code);
    const existing =
      (normalizedCode ? byCourseCode.get(normalizedCode) : undefined) ??
      byCourseId.get(course.id);

    if (existing) {
      if (!courseIsPre) {
        existing.isPreEnlistedCourse = false;
      }
      for (const comp of course.requiredComponents) {
        existing.rawRequiredComponents.add(normalizeComponentType(comp));
      }
      for (const option of course.sections) {
        collectCourseNodesFromOption(option, courseIsPre, existing.accMap, effectiveTermId);
      }
      if (normalizedCode && !byCourseCode.has(normalizedCode)) {
        byCourseCode.set(normalizedCode, existing);
      }
      if (course.id && !byCourseId.has(course.id)) {
        byCourseId.set(course.id, existing);
      }
      return;
    }

    const accMap = new Map<string, RawNodeAccumulator>();
    const rawRequiredComponents = new Set<ComponentType>(
      course.requiredComponents.map((c) => normalizeComponentType(c))
    );

    for (const option of course.sections) {
      collectCourseNodesFromOption(option, courseIsPre, accMap, effectiveTermId);
    }

    const record = {
      courseKey: course.instanceId || normalizedCode || `${course.id}::${merged.length}`,
      courseId: course.id,
      courseCode: course.code,
      units: course.units,
      isPreEnlistedCourse: courseIsPre,
      rawRequiredComponents,
      accMap,
    };

    merged.push(record);
    if (normalizedCode) {
      byCourseCode.set(normalizedCode, record);
    }
    if (course.id) {
      byCourseId.set(course.id, record);
    }
  };

  for (const c of preEnlistedCourses) {
    addCourse(c, true);
  }
  for (const c of intendedCourses) {
    addCourse(c, false);
  }

  return merged.map((m) => {
    // 1. Prevent child sections with non-standard topic subtitles from colliding with their parent's component.
    for (const acc of m.accMap.values()) {
      if (acc.parentSectionId) {
        const parentAcc = m.accMap.get(acc.parentSectionId);
        if (parentAcc && acc.component === parentAcc.component && !isStandardComponentType(acc.component)) {
          acc.component = SUBCOMPONENT_TYPE;
        }
      }
    }

    // 2. Unify standalone/root DEFAULT (topic-subtitle) sections with LEC when LEC is present
    //    and no child section uses DEFAULT, ensuring all root sections of the course share one sum == 1 bucket.
    const hasChildDefault = Array.from(m.accMap.values()).some(
      (acc) => acc.parentSectionId !== null && acc.component === DEFAULT_COMPONENT_TYPE
    );
    const hasLecRootOrDeclared =
      m.rawRequiredComponents.has('LEC') ||
      Array.from(m.accMap.values()).some(
        (acc) => acc.parentSectionId === null && acc.component === 'LEC'
      );

    if (hasLecRootOrDeclared && !hasChildDefault) {
      for (const acc of m.accMap.values()) {
        if (acc.parentSectionId === null && acc.component === DEFAULT_COMPONENT_TYPE) {
          acc.component = 'LEC';
        }
      }
      if (m.rawRequiredComponents.has(DEFAULT_COMPONENT_TYPE)) {
        m.rawRequiredComponents.delete(DEFAULT_COMPONENT_TYPE);
        m.rawRequiredComponents.add('LEC');
      }
    }

    // 3. Build required components: include every component present in accMap (so no section
    //    variable floats unconstrained) plus any declared standard required components
    //    (so missing mandatory components like LAB are caught as EXHAUSTED_CAPACITY).
    const required = new Set<ComponentType>();
    if (m.accMap.size === 0) {
      for (const comp of m.rawRequiredComponents) {
        required.add(comp);
      }
    } else {
      for (const acc of m.accMap.values()) {
        required.add(acc.component);
      }
      for (const comp of m.rawRequiredComponents) {
        if (isStandardComponentType(comp)) {
          required.add(comp);
        }
      }
    }

    return {
      courseKey: m.courseKey,
      courseId: m.courseId,
      courseCode: m.courseCode,
      units: m.units,
      isPreEnlistedCourse: m.isPreEnlistedCourse,
      rawRequiredComponents: Array.from(required),
      accMap: m.accMap,
    };
  });
}

function sectionHasDirectFixedDates(section: NormalizedSection): boolean {
  return (
    section.dates.length > 0 &&
    section.dates.every((d) => d.days.length > 0 && d.endMinutes > d.startMinutes)
  );
}

function sectionHasDirectCapacity(section: NormalizedSection): boolean {
  return section.activeClassSize < section.maxClassSize;
}

/**
 * Performs SPEC.md Section 5.1 preprocessing prior to CP-SAT variable creation:
 * 1. Normalizes courses & atomic section components (supporting nested parentClass and flat parentClassId).
 * 2. Filters TBA/asynchronous sections lacking fixed meeting schedules.
 * 3. Prunes zero-slot sections (`activeClassSize >= maxClassSize`), exempting pre-enlisted sections.
 * 4. Drops orphaned child sections whose linked parent did not survive pruning, and detects exhausted capacity early.
 * 5. Builds day-indexed meeting occurrences, pairwise overlap lists, and blocked-time masks.
 */
export function preprocessAcademicPlan(
  plan: AcademicPlanState,
  unitLimitsOverride?: UnitLimitsConfig
): PreprocessedProblem {
  const effectiveTermId = resolveEffectiveTermId(plan);
  const mergedCourses = mergeCourseEntries(
    plan.preEnlistedCourses,
    plan.intendedCourses,
    effectiveTermId
  );

  const courses: PreprocessedCourse[] = [];
  const nodes: SolverSectionNode[] = [];
  const nodeIndexByCourseAndSectionId = new Map<string, number>();
  const exhaustedCourses: ExhaustedCourseInfo[] = [];

  let totalUnits = 0;

  for (const entry of mergedCourses) {
    totalUnits += entry.units;

    // Step 1: Individual section TBA & capacity pruning (exempting pre-enlisted sections from capacity pruning).
    const survivingAcc = new Map<string, RawNodeAccumulator>();
    for (const [secId, acc] of entry.accMap.entries()) {
      const fixedDirect = sectionHasDirectFixedDates(acc.section);
      const fixedChain = hasFixedSchedule(acc.section);
      if (!fixedDirect || !fixedChain) {
        continue;
      }

      if (!acc.isPreEnlisted) {
        const capDirect = sectionHasDirectCapacity(acc.section);
        // If parent is nested and not pre-enlisted, parent capacity must also be open.
        const parentAcc = acc.parentSectionId ? entry.accMap.get(acc.parentSectionId) : undefined;
        const parentExempt = parentAcc?.isPreEnlisted ?? false;
        const capChain = parentExempt ? capDirect : hasAvailableCapacity(acc.section);
        if (!capDirect || !capChain) {
          continue;
        }
      }

      survivingAcc.set(secId, acc);
    }

    // Step 2: Fixed-point prune orphaned child sections whose parentSectionId did not survive.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [secId, acc] of Array.from(survivingAcc.entries())) {
        if (acc.parentSectionId && !survivingAcc.has(acc.parentSectionId)) {
          survivingAcc.delete(secId);
          changed = true;
        }
      }
    }

    // Step 3: Materialize SolverSectionNodes for surviving sections.
    const localNodeBySecId = new Map<string, SolverSectionNode>();
    const nodeIndicesByComponent = new Map<ComponentType, number[]>();

    for (const comp of entry.rawRequiredComponents) {
      nodeIndicesByComponent.set(comp, []);
    }

    for (const acc of survivingAcc.values()) {
      const nodeIndex = nodes.length;
      const meetsOnFriday = acc.section.dates.some((d) => d.days.includes('Friday'));
      const node: SolverSectionNode = {
        nodeIndex,
        varKey: `${entry.courseKey}::${acc.section.id}`,
        courseKey: entry.courseKey,
        courseId: entry.courseId,
        courseCode: entry.courseCode,
        sectionId: acc.section.id,
        sectionName: acc.section.section,
        component: acc.component,
        dates: acc.section.dates,
        parentSectionId: acc.parentSectionId,
        parentNodeIndex: null,
        isPreEnlisted: acc.isPreEnlisted,
        isExplicitOption: acc.isExplicitOption,
        flags: { ...acc.flags },
        meetsOnFriday,
        activeClassSize: acc.section.activeClassSize,
        maxClassSize: acc.section.maxClassSize,
      };

      nodes.push(node);
      localNodeBySecId.set(node.sectionId, node);
      nodeIndexByCourseAndSectionId.set(node.varKey, nodeIndex);

      const list = nodeIndicesByComponent.get(node.component) ?? [];
      list.push(nodeIndex);
      nodeIndicesByComponent.set(node.component, list);
    }

    // Resolve parentNodeIndex links and build parent-child linkage groups (Eq. 3).
    const childComponentsByParentComponent = new Map<ComponentType, Set<ComponentType>>();
    for (const node of localNodeBySecId.values()) {
      if (node.parentSectionId) {
        const parentNode = localNodeBySecId.get(node.parentSectionId);
        if (parentNode) {
          node.parentNodeIndex = parentNode.nodeIndex;
          const childSet =
            childComponentsByParentComponent.get(parentNode.component) ?? new Set<ComponentType>();
          childSet.add(node.component);
          childComponentsByParentComponent.set(parentNode.component, childSet);
        }
      }
    }

    // Also inspect pre-pruning structure for parent->child component relationships so
    // an exhausted child component is detected even if all children were pruned.
    for (const acc of entry.accMap.values()) {
      if (acc.parentSectionId) {
        const parentAcc = entry.accMap.get(acc.parentSectionId);
        if (parentAcc) {
          const childSet =
            childComponentsByParentComponent.get(parentAcc.component) ?? new Set<ComponentType>();
          childSet.add(acc.component);
          childComponentsByParentComponent.set(parentAcc.component, childSet);
        }
      }
    }

    const linkageGroups: ParentChildLinkageGroup[] = [];
    for (const [parentComp, childComps] of childComponentsByParentComponent.entries()) {
      const parentIndices = nodeIndicesByComponent.get(parentComp) ?? [];
      for (const parentNodeIndex of parentIndices) {
        const parentNode = nodes[parentNodeIndex];
        for (const childComp of childComps) {
          const childIndices = (nodeIndicesByComponent.get(childComp) ?? []).filter(
            (idx) => nodes[idx].parentSectionId === parentNode.sectionId
          );
          linkageGroups.push({
            courseKey: entry.courseKey,
            parentNodeIndex,
            childComponent: childComp,
            childNodeIndices: childIndices,
          });
        }
      }
    }

    // Step 4: Exhausted Capacity Early Check (SPEC.md Section 5.1 #4).
    if (!entry.isPreEnlistedCourse) {
      if (entry.rawRequiredComponents.length === 0 || localNodeBySecId.size === 0) {
        exhaustedCourses.push({
          courseKey: entry.courseKey,
          courseId: entry.courseId,
          courseCode: entry.courseCode,
          reason: `${entry.courseCode} currently has 0 open non-TBA sections.`,
        });
      } else {
        let missingComponent: ComponentType | null = null;
        for (const reqComp of entry.rawRequiredComponents) {
          const survivingForComp = nodeIndicesByComponent.get(reqComp) ?? [];
          if (survivingForComp.length === 0) {
            missingComponent = reqComp;
            break;
          }
        }
        if (missingComponent !== null) {
          exhaustedCourses.push({
            courseKey: entry.courseKey,
            courseId: entry.courseId,
            courseCode: entry.courseCode,
            reason: `${entry.courseCode} has 0 open non-TBA sections for required component ${missingComponent}.`,
          });
        } else {
          // Verify at least one parent section has at least one child for every required child component.
          for (const [parentComp, childComps] of childComponentsByParentComponent.entries()) {
            const parentIndices = nodeIndicesByComponent.get(parentComp) ?? [];
            const hasValidParent = parentIndices.some((pIdx) =>
              Array.from(childComps).every((childComp) => {
                const group = linkageGroups.find(
                  (g) => g.parentNodeIndex === pIdx && g.childComponent === childComp
                );
                return group !== undefined && group.childNodeIndices.length > 0;
              })
            );
            if (!hasValidParent) {
              exhaustedCourses.push({
                courseKey: entry.courseKey,
                courseId: entry.courseId,
                courseCode: entry.courseCode,
                reason: `${entry.courseCode} has 0 valid open parent-child section combinations.`,
              });
              break;
            }
          }
        }
      }
    }

    courses.push({
      courseKey: entry.courseKey,
      courseId: entry.courseId,
      courseCode: entry.courseCode,
      units: entry.units,
      isPreEnlistedCourse: entry.isPreEnlistedCourse,
      requiredComponents: entry.rawRequiredComponents,
      nodeIndicesByComponent,
      linkageGroups,
    });
  }

  // Step 5: Build day-indexed meeting occurrences.
  const occurrencesByDay: Record<Weekday, DayOccurrence[]> = {
    Monday: [],
    Tuesday: [],
    Wednesday: [],
    Thursday: [],
    Friday: [],
    Saturday: [],
  };

  for (const node of nodes) {
    for (const interval of node.dates) {
      for (const day of interval.days) {
        occurrencesByDay[day].push({
          occurrenceIndex: 0,
          nodeIndex: node.nodeIndex,
          day,
          start: interval.startMinutes,
          end: interval.endMinutes,
          duration: interval.endMinutes - interval.startMinutes,
        });
      }
    }
  }

  for (const day of WEEKDAYS) {
    occurrencesByDay[day].sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      if (a.end !== b.end) return a.end - b.end;
      return a.nodeIndex - b.nodeIndex;
    });
    occurrencesByDay[day].forEach((occ, idx) => {
      occ.occurrenceIndex = idx;
    });
  }

  // Step 6: Compute all overlapping node pairs (Eq. 4 & Eq. 5).
  const overlappingPairs: Array<[number, number]> = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (sectionDatesOverlap(nodes[i].dates, nodes[j].dates)) {
        overlappingPairs.push([i, j]);
      }
    }
  }

  // Step 7: Identify blocked nodes (Eq. 7).
  const blockedNodeIndices = new Set<number>();
  if (plan.blockedCells.length > 0) {
    for (const node of nodes) {
      for (const cell of plan.blockedCells) {
        if (sectionDatesOverlapBlockedCell(node.dates, cell)) {
          blockedNodeIndices.add(node.nodeIndex);
          break;
        }
      }
    }
  }

  const flexibleNodeIndices = nodes.filter((n) => !n.isPreEnlisted).map((n) => n.nodeIndex);
  const anyStarredSelectable = nodes.some(
    (n) => !n.isPreEnlisted && n.isExplicitOption && n.flags.isStarred
  );

  const unitLimits: UnitLimitsConfig | null =
    unitLimitsOverride ?? plan.unitLimits ?? null;

  return {
    courses,
    nodes,
    nodeIndexByCourseAndSectionId,
    occurrencesByDay,
    overlappingPairs,
    blockedNodeIndices,
    exhaustedCourses,
    flexibleNodeIndices,
    anyStarredSelectable,
    totalUnits,
    unitLimits,
  };
}
