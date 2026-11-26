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
  type PreprocessOptions,
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
  DEFAULT_QUICKXPLAIN_MAX_CHECKS,
  DEFAULT_QUICKXPLAIN_PROBE_TIME_LIMIT_SECONDS,
  DEFAULT_QUICKXPLAIN_TIME_LIMIT_SECONDS,
  QuickXplainFallbackError,
  assertQuickXplainBudget,
  buildForegroundConstraints,
  buildPureSatSubsetModel,
  checkSubsetConsistencyPureSat,
  createQuickXplainBudget,
  findMinimalConflict,
  mergeContiguousBlockedCells,
  quickXplain,
  verifyMusProperties,
  type BuiltPureSatModel,
  type ConsistencyOracle,
  type ForegroundConstraintItem,
  type MergedBlockedWindow,
  type MusVerificationReport,
  type QuickXplainBudget,
  type QuickXplainResult,
  type QuickXplainStatus,
} from './quickxplain.ts';

export {
  applyRelaxationToPlan,
  buildDataInconsistencyDiagnosis,
  buildExhaustedCapacityDiagnosis,
  buildRelaxationActionsFromMus,
  buildResourceFallbackDiagnosis,
  formatDaySummary,
  formatMergedTimeWindowSummary,
  formatMinutesDisplay,
  formatTimeRange,
  mapMusToDiagnosis,
} from './explainer.ts';

export {
  DEFAULT_MAX_FALLBACK_OPTIONS,
  diagnoseAcademicPlan,
  diagnosePreprocessedProblem,
  type DiagnosisRunResult,
} from './diagnosis.ts';

export {
  computeScheduleValidityRate,
  validateScheduleAlternative,
  type ScheduleValidationResult,
  type ScheduleValidationViolation,
  type SvrEvaluationReport,
  type ValidationViolationCode,
} from './validator.ts';
