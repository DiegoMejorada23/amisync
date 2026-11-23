/**
 * Solver input/output and QuickXplain MUS diagnostic payloads matching SPEC.md Section 4.4.
 */

import type { Weekday } from './domain.ts';

export type SolverTerminalStatus = 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'TIMEOUT_ABORT';

export interface GeneratedScheduleAlternative {
  planLabel: string;                // e.g., "Plan A", "Plan B", "Plan C"
  profileTag: string;               // e.g., "Balanced", "Recommended"
  totalUnits: number;
  status: 'OPTIMAL' | 'FEASIBLE';
  objectiveScoreZ: number;
  selectedSectionIds: string[];     // Flat list of selected section/component IDs (incl. parents & pre-enlisted)
  hammingDistanceFromPrev: number[];
}

export type ConflictOrigin =
  | 'DATA_INCONSISTENCY'            // Background set B is unsatisfiable
  | 'EXHAUSTED_CAPACITY'            // Intended course has 0 available sections after pruning
  | 'PREFERENCE_CONFLICT'           // QuickXplain MUS isolated from Foreground set C
  | 'SOLVER_RESOURCE_FALLBACK';     // Memory/timeout abort during QuickXplain recursion

export type ForegroundConstraintRef =
  | { kind: 'INTENDED_COURSE'; courseId: string; courseCode: string; priorityWeight: number }
  | { kind: 'TIME_BLOCK'; blockId: string; day: Weekday; startMinutes: number; endMinutes: number; priorityWeight: number }
  | { kind: 'HIDDEN_SECTION'; courseId: string; courseCode: string; sectionId: string; sectionName: string; priorityWeight: number }
  | { kind: 'USER_LOCKED_SECTION'; courseId: string; courseCode: string; sectionId: string; sectionName: string; priorityWeight: number };

export type RelaxationActionType =
  | 'UNBLOCK_TIME_WINDOW'
  | 'UNHIDE_SECTION'
  | 'UNLOCK_SECTION'
  | 'DROP_OR_REPLACE_COURSE';

export interface RelaxationAction {
  /** Deterministic identifier for this actionable relaxation option. */
  id: string;
  /** Concise human-readable label (e.g., "Unblock Tue 1:00 PM - 4:00 PM"). */
  label: string;
  /** Clear explanation of what changes if this relaxation is applied. */
  description: string;
  /** The MUS constraint(s) relaxed by this action. */
  relaxedConstraints: ForegroundConstraintRef[];
  /** Action category enabling deterministic 1-click HITL resolution in the UI. */
  actionType: RelaxationActionType;
}

export interface FallbackScheduleOption {
  /** The relaxation applied to recover feasibility. */
  relaxation: RelaxationAction;
  /** Verified feasible/optimal schedule produced when this relaxation is applied. */
  schedule: GeneratedScheduleAlternative;
}

export interface InfeasibilityDiagnosis {
  origin: ConflictOrigin;
  mus: ForegroundConstraintRef[];
  hardClashCount: number;
  conflictSummaryBullets: string[]; // Rendered from deterministic templates
  relaxationSuggestions: string[];  // Actionable advice (unblock window / drop or swap course)
  affectedCourseCodes: string[];    // Highlighted inline chips, e.g., ["CMSC 128"]
  /** Structured relaxation actions derived directly from the extracted MUS. */
  relaxationActions?: RelaxationAction[];
  /** Verified fallback schedule options obtained by relaxing individual MUS constraints. */
  fallbackOptions?: FallbackScheduleOption[];
  /** True when relaxing non-course preferences (time blocks, hides, locks) cannot resolve the conflict. */
  isStructuralConflict?: boolean;
}

export interface SolverTimingProfile {
  wasmInitMs: number;
  modelConstructionMs: number;
  solverExecutionMs: number;
  musExtractionMs?: number;
}

export interface SolverResponsePayload {
  status: SolverTerminalStatus;
  alternatives: GeneratedScheduleAlternative[];
  diagnosis: InfeasibilityDiagnosis | null;
  timing: SolverTimingProfile;
}
