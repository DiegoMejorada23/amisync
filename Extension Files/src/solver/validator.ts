import { hasAvailableCapacity, hasFixedSchedule } from '../amis/parser.ts';
import type {
  AcademicPlanState,
  ComponentType,
  CourseEntry,
  NormalizedSection,
  UnitLimitsConfig,
} from '../types/domain.ts';
import type { GeneratedScheduleAlternative } from '../types/solver.ts';
import {
  normalizeComponentType,
  sectionDatesOverlap,
  sectionDatesOverlapBlockedCell,
} from './preprocess.ts';

export type ValidationViolationCode =
  | 'UNKNOWN_SECTION_ID'
  | 'TIME_OVERLAP'
  | 'MISSING_PRE_ENLISTED'
  | 'MISSING_REQUIRED_COMPONENT'
  | 'DUPLICATE_COMPONENT'
  | 'BROKEN_PARENT_LINKAGE'
  | 'CAPACITY_EXCEEDED'
  | 'TBA_SECTION_SELECTED'
  | 'HIDDEN_SECTION_SELECTED'
  | 'BLOCKED_TIME_VIOLATION'
  | 'LOCKED_SECTION_MISSING'
  | 'UNIT_LIMIT_VIOLATION';

export interface ScheduleValidationViolation {
  code: ValidationViolationCode;
  message: string;
  sectionIds?: string[];
  courseCode?: string;
}

export interface ScheduleValidationResult {
  valid: boolean;
  violations: ScheduleValidationViolation[];
}

export interface SvrEvaluationReport {
  totalSchedules: number;
  validSchedules: number;
  scheduleValidityRate: number; // Ratio in [0, 1]; target 1.0 (100%)
  results: ScheduleValidationResult[];
}

interface CatalogEntry {
  courseKey: string;
  courseId: string;
  courseCode: string;
  units: number;
  section: NormalizedSection;
  component: ComponentType;
  parentSectionId: string | null;
  isPreEnlisted: boolean;
  isHidden: boolean;
  isLocked: boolean;
}

function indexPlanCatalog(plan: AcademicPlanState): {
  bySectionId: Map<string, CatalogEntry>;
  courseRequirements: Map<
    string,
    {
      courseKey: string;
      courseCode: string;
      units: number;
      requiredComponents: Set<ComponentType>;
      childCompByParentComp: Map<ComponentType, Set<ComponentType>>;
    }
  >;
} {
  const bySectionId = new Map<string, CatalogEntry>();
  const courseRequirements = new Map<
    string,
    {
      courseKey: string;
      courseCode: string;
      units: number;
      requiredComponents: Set<ComponentType>;
      childCompByParentComp: Map<ComponentType, Set<ComponentType>>;
    }
  >();

  const courseKeyByCourseId = new Map<string, string>();

  const registerCourse = (course: CourseEntry, fromPreEnlisted: boolean) => {
    const existingKey = !course.canEnrollMultiple
      ? courseKeyByCourseId.get(course.id)
      : undefined;
    const courseKey = existingKey ?? (course.instanceId || course.id);
    if (!course.canEnrollMultiple) {
      courseKeyByCourseId.set(course.id, courseKey);
    }

    let req = courseRequirements.get(courseKey);
    if (!req) {
      req = {
        courseKey,
        courseCode: course.code,
        units: course.units,
        requiredComponents: new Set<ComponentType>(
          course.requiredComponents.map((c) => normalizeComponentType(c))
        ),
        childCompByParentComp: new Map<ComponentType, Set<ComponentType>>(),
      };
      courseRequirements.set(courseKey, req);
    } else {
      for (const comp of course.requiredComponents) {
        req.requiredComponents.add(normalizeComponentType(comp));
      }
    }

    const coursePre = fromPreEnlisted || course.isPreEnlisted;
    const seenComponents = new Set<ComponentType>();

    const registerSection = (
      sec: NormalizedSection,
      isLeaf: boolean,
      inheritedPre: boolean,
      flags: { isHidden: boolean; isLocked: boolean }
    ) => {
      if (sec.parentClass) {
        registerSection(sec.parentClass, false, inheritedPre, {
          isHidden: false,
          isLocked: false,
        });
      }

      const comp = normalizeComponentType(sec.activity);
      seenComponents.add(comp);
      const parentSectionId = sec.parentClass?.id ?? sec.parentClassId ?? null;

      const existing = bySectionId.get(sec.id);
      if (!existing) {
        bySectionId.set(sec.id, {
          courseKey,
          courseId: course.id,
          courseCode: course.code,
          units: course.units,
          section: sec,
          component: comp,
          parentSectionId,
          isPreEnlisted: inheritedPre,
          isHidden: isLeaf ? flags.isHidden : false,
          isLocked: isLeaf ? flags.isLocked : false,
        });
      } else {
        existing.isPreEnlisted = existing.isPreEnlisted || inheritedPre;
        if (isLeaf) {
          existing.isHidden = existing.isHidden || flags.isHidden;
          existing.isLocked = existing.isLocked || flags.isLocked;
        }
        if (!existing.parentSectionId && parentSectionId) {
          existing.parentSectionId = parentSectionId;
        }
      }
    };

    for (const opt of course.sections) {
      registerSection(opt.section, true, coursePre || opt.isPreEnlisted, {
        isHidden: opt.flags.isHidden,
        isLocked: opt.flags.isLocked,
      });
    }

    if (req.requiredComponents.size === 0) {
      for (const comp of seenComponents) {
        req.requiredComponents.add(comp);
      }
    }
  };

  for (const c of plan.preEnlistedCourses) {
    registerCourse(c, true);
  }
  for (const c of plan.intendedCourses) {
    registerCourse(c, false);
  }

  // Record parent -> child component relationships per course
  for (const entry of bySectionId.values()) {
    if (entry.parentSectionId) {
      const parent = bySectionId.get(entry.parentSectionId);
      const req = courseRequirements.get(entry.courseKey);
      if (parent && req) {
        const set = req.childCompByParentComp.get(parent.component) ?? new Set<ComponentType>();
        set.add(entry.component);
        req.childCompByParentComp.set(parent.component, set);
      }
    }
  }

  return { bySectionId, courseRequirements };
}

/**
 * Independent post-execution Schedule Validity Rate (SVR) validator (SPEC.md Section 9 Phase 3).
 * Verifies 100% zero temporal overlap, intact parent-child linkages, capacity limits,
 * TBA exclusion, pre-enlisted anchors, user locks/hides, blocked cells, and unit limits.
 */
export function validateScheduleAlternative(
  plan: AcademicPlanState,
  alternative: GeneratedScheduleAlternative,
  unitLimitsOverride?: UnitLimitsConfig
): ScheduleValidationResult {
  const violations: ScheduleValidationViolation[] = [];
  const { bySectionId, courseRequirements } = indexPlanCatalog(plan);
  const selectedIds = new Set(alternative.selectedSectionIds);
  const selectedEntries: CatalogEntry[] = [];

  // 1. Resolve all selected section IDs
  for (const id of selectedIds) {
    const entry = bySectionId.get(id);
    if (!entry) {
      violations.push({
        code: 'UNKNOWN_SECTION_ID',
        message: `Selected section ID "${id}" does not exist in the academic plan.`,
        sectionIds: [id],
      });
      continue;
    }
    selectedEntries.push(entry);
  }

  // 2. Check TBA, capacity, hidden, and blocked time cells on selected sections
  for (const entry of selectedEntries) {
    if (!hasFixedSchedule(entry.section)) {
      violations.push({
        code: 'TBA_SECTION_SELECTED',
        message: `TBA/asynchronous section ${entry.courseCode} ${entry.section.section} was selected.`,
        sectionIds: [entry.section.id],
        courseCode: entry.courseCode,
      });
    }

    if (!entry.isPreEnlisted && !hasAvailableCapacity(entry.section)) {
      violations.push({
        code: 'CAPACITY_EXCEEDED',
        message: `Full section ${entry.courseCode} ${entry.section.section} (${entry.section.activeClassSize}/${entry.section.maxClassSize}) was selected.`,
        sectionIds: [entry.section.id],
        courseCode: entry.courseCode,
      });
    }

    if (!entry.isPreEnlisted && entry.isHidden) {
      violations.push({
        code: 'HIDDEN_SECTION_SELECTED',
        message: `Hidden section ${entry.courseCode} ${entry.section.section} was selected.`,
        sectionIds: [entry.section.id],
        courseCode: entry.courseCode,
      });
    }

    for (const cell of plan.blockedCells) {
      if (sectionDatesOverlapBlockedCell(entry.section.dates, cell)) {
        violations.push({
          code: 'BLOCKED_TIME_VIOLATION',
          message: `Section ${entry.courseCode} ${entry.section.section} overlaps blocked cell ${cell.id}.`,
          sectionIds: [entry.section.id],
          courseCode: entry.courseCode,
        });
        break;
      }
    }
  }

  // 3. Verify all pre-enlisted anchors and user-locked sections are selected
  for (const entry of bySectionId.values()) {
    if (entry.isPreEnlisted && !selectedIds.has(entry.section.id)) {
      violations.push({
        code: 'MISSING_PRE_ENLISTED',
        message: `Pre-enlisted section ${entry.courseCode} ${entry.section.section} is missing from schedule.`,
        sectionIds: [entry.section.id],
        courseCode: entry.courseCode,
      });
    }
    if (entry.isLocked && !selectedIds.has(entry.section.id)) {
      violations.push({
        code: 'LOCKED_SECTION_MISSING',
        message: `User-locked section ${entry.courseCode} ${entry.section.section} is missing from schedule.`,
        sectionIds: [entry.section.id],
        courseCode: entry.courseCode,
      });
    }
  }

  // 4. Pairwise temporal exclusivity across all selected sections
  for (let i = 0; i < selectedEntries.length; i++) {
    for (let j = i + 1; j < selectedEntries.length; j++) {
      const a = selectedEntries[i];
      const b = selectedEntries[j];
      if (sectionDatesOverlap(a.section.dates, b.section.dates)) {
        violations.push({
          code: 'TIME_OVERLAP',
          message: `Temporal overlap between ${a.courseCode} ${a.section.section} and ${b.courseCode} ${b.section.section}.`,
          sectionIds: [a.section.id, b.section.id],
        });
      }
    }
  }

  // 5. Required component satisfaction & parent-child co-requisite linkage
  for (const req of courseRequirements.values()) {
    const courseSelected = selectedEntries.filter((e) => e.courseKey === req.courseKey);

    for (const comp of req.requiredComponents) {
      const matching = courseSelected.filter((e) => e.component === comp);
      if (matching.length === 0) {
        violations.push({
          code: 'MISSING_REQUIRED_COMPONENT',
          message: `Course ${req.courseCode} is missing required component ${comp}.`,
          courseCode: req.courseCode,
        });
      } else if (matching.length > 1) {
        violations.push({
          code: 'DUPLICATE_COMPONENT',
          message: `Course ${req.courseCode} selected ${matching.length} sections for component ${comp}.`,
          sectionIds: matching.map((m) => m.section.id),
          courseCode: req.courseCode,
        });
      }
    }

    // Check every selected child's parent is selected
    for (const entry of courseSelected) {
      if (entry.parentSectionId && !selectedIds.has(entry.parentSectionId)) {
        violations.push({
          code: 'BROKEN_PARENT_LINKAGE',
          message: `Selected child ${entry.courseCode} ${entry.section.section} requires parent section ID ${entry.parentSectionId}.`,
          sectionIds: [entry.section.id, entry.parentSectionId],
          courseCode: entry.courseCode,
        });
      }
    }

    // Check every selected parent has matching selected child for each required child component
    for (const entry of courseSelected) {
      const childComps = req.childCompByParentComp.get(entry.component);
      if (!childComps) continue;
      for (const childComp of childComps) {
        const linkedChildren = courseSelected.filter(
          (c) => c.component === childComp && c.parentSectionId === entry.section.id
        );
        if (linkedChildren.length !== 1) {
          violations.push({
            code: 'BROKEN_PARENT_LINKAGE',
            message: `Parent ${entry.courseCode} ${entry.section.section} expected 1 linked ${childComp} child, found ${linkedChildren.length}.`,
            sectionIds: [entry.section.id],
            courseCode: entry.courseCode,
          });
        }
      }
    }
  }

  // 6. Optional academic plan unit limits check
  const unitLimits = unitLimitsOverride ?? plan.unitLimits;
  if (unitLimits) {
    const scheduledCourseKeys = new Set(selectedEntries.map((e) => e.courseKey));
    let totalUnits = 0;
    for (const key of scheduledCourseKeys) {
      totalUnits += courseRequirements.get(key)?.units ?? 0;
    }

    if (
      typeof unitLimits.minUnits === 'number' &&
      Number.isFinite(unitLimits.minUnits) &&
      totalUnits + 1e-6 < unitLimits.minUnits
    ) {
      violations.push({
        code: 'UNIT_LIMIT_VIOLATION',
        message: `Scheduled units (${totalUnits}) are below minimum unit limit (${unitLimits.minUnits}).`,
      });
    }
    if (
      typeof unitLimits.maxUnits === 'number' &&
      Number.isFinite(unitLimits.maxUnits) &&
      totalUnits - 1e-6 > unitLimits.maxUnits
    ) {
      violations.push({
        code: 'UNIT_LIMIT_VIOLATION',
        message: `Scheduled units (${totalUnits}) exceed maximum unit limit (${unitLimits.maxUnits}).`,
      });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Evaluates Schedule Validity Rate (SVR) across a batch of generated schedule alternatives.
 */
export function computeScheduleValidityRate(
  plan: AcademicPlanState,
  alternatives: readonly GeneratedScheduleAlternative[],
  unitLimitsOverride?: UnitLimitsConfig
): SvrEvaluationReport {
  const results = alternatives.map((alt) =>
    validateScheduleAlternative(plan, alt, unitLimitsOverride)
  );
  const validSchedules = results.filter((r) => r.valid).length;
  const totalSchedules = alternatives.length;
  return {
    totalSchedules,
    validSchedules,
    scheduleValidityRate: totalSchedules === 0 ? 1 : validSchedules / totalSchedules,
    results,
  };
}
