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

export interface InfeasibilityDiagnosis {
  origin: ConflictOrigin;
  mus: ForegroundConstraintRef[];
  hardClashCount: number;
  conflictSummaryBullets: string[]; // Rendered from deterministic templates
  relaxationSuggestions: string[];  // Actionable advice (unblock window / drop or swap course)
  affectedCourseCodes: string[];    // Highlighted inline chips, e.g., ["CMSC 128"]
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
