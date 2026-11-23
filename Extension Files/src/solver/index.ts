export {
  DEFAULT_COMPONENT_TYPE,
  normalizeComponentType,
  preprocessAcademicPlan,
  sectionDatesOverlap,
  sectionDatesOverlapBlockedCell,
  timeslotIntervalsOverlap,
  type DayOccurrence,
  type ExhaustedCourseInfo,
  type ParentChildLinkageGroup,
  type PreprocessedCourse,
  type PreprocessedProblem,
  type SolverSectionNode,
} from './preprocess.ts';

export {
  OBJECTIVE_PRECISION_SCALE,
  SOFT_PENALTY_KEYS,
  computeDynamicMaxPenalties,
  computeObjectiveWeights,
  evaluateSelectionObjective,
  type EvaluatedObjective,
  type ObjectiveWeightsSummary,
  type SoftPenaltyKey,
  type SoftPenaltyMap,
} from './objective.ts';

export {
  buildCpSatModel,
  type BuiltCpSatModel,
  type ExclusionCut,
} from './modelBuilder.ts';

export {
  DEFAULT_SOLVER_TIME_LIMIT_SECONDS,
  computeHammingDistance,
  ensureWasmInitialized,
  getCachedWasmInitMs,
  solveAcademicPlan,
} from './engine.ts';

export {
  computeScheduleValidityRate,
  validateScheduleAlternative,
  type ScheduleValidationResult,
  type ScheduleValidationViolation,
  type SvrEvaluationReport,
  type ValidationViolationCode,
} from './validator.ts';
