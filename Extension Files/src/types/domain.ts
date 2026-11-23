/**
 * Normalized domain models, student preferences, visual time blocks,
 * and academic plan constraints matching SPEC.md Sections 4.2 and 4.3.
 */

export type Weekday =
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday';

export const WEEKDAYS: readonly Weekday[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type ComponentType = 'LEC' | 'LAB' | 'RECIT' | string;

export interface FacultyName {
  firstName: string;
  middleName: string;
  lastName: string;
}

/**
 * Normalized meeting interval in both display format and CP-SAT integer minutes.
 * Minutes range strictly over [0, 1440] (minutes since midnight).
 */
export interface TimeslotInterval {
  days: Weekday[];
  startTime: string;      // Original "hh:mm AM/PM"
  endTime: string;        // Original "hh:mm AM/PM"
  startMinutes: number;   // Integer in [0, 1440]
  endMinutes: number;     // Integer in [0, 1440]
}

/**
 * Normalized single AMIS class component (e.g., a standalone LEC or a LAB with parentClass).
 */
export interface NormalizedSection {
  id: string;                        // Stringified AMIS class id
  courseId: string;                  // Stringified AMIS course_id
  section: string;                   // e.g., "AB-1L", "S", "S-4L"
  activity: ComponentType | null;    // Normalized: "" -> null
  faculties: FacultyName[];
  location: string | null;           // From facility_id, e.g., "ICS LH3"
  dates: TimeslotInterval[];
  activeClassSize: number;
  maxClassSize: number;
  isPrerogOpen: boolean;
  parentClassId: string | null;      // Derived from parent.id ?? parent_class_id
  parentClass: NormalizedSection | null;
}

/**
 * Per-section user overrides captured from the Courses tab (Eye / Lock / Star icons).
 */
export interface SectionUserFlags {
  isHidden: boolean;       // Eye icon  -> Hard constraint: x_{c,k,s} = 0
  isLocked: boolean;       // Lock icon -> Hard constraint: x_{c,k,s} = 1
  isStarred: boolean;      // Star icon -> Soft constraint: I_unstarred = 0
}

export interface CourseSectionOption {
  section: NormalizedSection;        // Leaf section (or standalone LEC)
  flags: SectionUserFlags;
  isPreEnlisted: boolean;            // True if sourced from Enlisted / Sent to SAIS
}

export interface CourseEntry {
  instanceId: string;                // crypto.randomUUID()
  id: string;                        // Stringified course_id
  code: string;                      // e.g., "CMSC 128"
  units: number;                     // Parsed float
  canEnrollMultiple: boolean;
  isPreEnlisted: boolean;            // Locked anchor course
  requiredComponents: ComponentType[]; // Derived during preprocessing (e.g., ["LEC", "LAB"])
  sections: CourseSectionOption[];
  isExpanded: boolean;               // Accordion UI state
}

export type PreferencePriority = 'Off' | 'Low' | 'Medium' | 'High';

/**
 * Exact thesis mapping: Off -> 0, Low -> 2, Medium -> 5, High -> 10.
 */
export const PRIORITY_WEIGHT_MAP: Record<PreferencePriority, 0 | 2 | 5 | 10> = {
  Off: 0,
  Low: 2,
  Medium: 5,
  High: 10,
};

/**
 * Hourly grid cell blocked by the user on the visual timetable (7:00 AM - 7:00 PM, Mon - Sat).
 */
export interface BlockedTimeCell {
  id: string;            // e.g., "Tuesday:780-840"
  day: Weekday;
  startMinutes: number;  // e.g., 780 (1:00 PM)
  endMinutes: number;    // e.g., 840 (2:00 PM)
}

export interface StudentPreferences {
  fatigueLimit: {
    priority: PreferencePriority;
    maxConsecutiveHours: number;    // Slider: 1..12 hrs (default shown: 6)
  };
  acceptableDayBounds: {
    priority: PreferencePriority;   // Shared dropdown controlling Early Start & Late End weights
    earliestStartMinutes: number;   // Slider: 420..1140 (07:00 AM..07:00 PM; default shown: 420 = 07:00 AM)
    latestEndMinutes: number;       // Slider: 420..1140 (07:00 AM..07:00 PM; default shown: 1080 = 06:00 PM)
  };
  minimizeFridayClasses: {
    priority: PreferencePriority;   // Default shown: "Medium"
  };
  batchSubjectsToFewerDays: {
    priority: PreferencePriority;   // Default shown: "Medium"
  };
  minimizeExcessiveGaps: {
    priority: PreferencePriority;   // Default shown: "High"; fixed > 120 min threshold
    gapThresholdMinutes: 120;
  };
  starredSectionPreference: {
    priority: PreferencePriority;   // Governs P_section weight W_section in Eq (13)
  };
}

export interface DiversityConfig {
  maxAlternatives: 3;               // Up to 3 distinct schedule recommendations
  minDifferingSections: number;     // Tunable m (e.g., m=1 => D>=2, m=2 => D>=4)
  minHammingDistance: number;       // 2 * m (baseline >= 2; stricter >= 4)
  alternatePreferenceProfiles: boolean;
}

export interface AcademicPlanState {
  schemaVersion: string;            // Versioned chrome.storage.local envelope
  termId: number | null;
  preEnlistedCourses: CourseEntry[];
  intendedCourses: CourseEntry[];
  blockedCells: BlockedTimeCell[];
  preferences: StudentPreferences;
  diversity: DiversityConfig;
  lastRefreshTime: string | null;   // ISO timestamp
}

export const PLAN_SCHEMA_VERSION = '1.0.0';

export const DEFAULT_STUDENT_PREFERENCES: StudentPreferences = {
  fatigueLimit: {
    priority: 'High',
    maxConsecutiveHours: 6,
  },
  acceptableDayBounds: {
    priority: 'High',
    earliestStartMinutes: 420,  // 07:00 AM
    latestEndMinutes: 1080,     // 06:00 PM
  },
  minimizeFridayClasses: {
    priority: 'Medium',
  },
  batchSubjectsToFewerDays: {
    priority: 'Medium',
  },
  minimizeExcessiveGaps: {
    priority: 'High',
    gapThresholdMinutes: 120,
  },
  starredSectionPreference: {
    priority: 'Medium',
  },
};

export const DEFAULT_DIVERSITY_CONFIG: DiversityConfig = {
  maxAlternatives: 3,
  minDifferingSections: 1,
  minHammingDistance: 2,
  alternatePreferenceProfiles: true,
};

/**
 * Creates a fresh default AcademicPlanState matching SPEC.md Section 4.3 and 7.4 defaults.
 */
export function createDefaultAcademicPlanState(): AcademicPlanState {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    termId: null,
    preEnlistedCourses: [],
    intendedCourses: [],
    blockedCells: [],
    preferences: {
      fatigueLimit: { ...DEFAULT_STUDENT_PREFERENCES.fatigueLimit },
      acceptableDayBounds: { ...DEFAULT_STUDENT_PREFERENCES.acceptableDayBounds },
      minimizeFridayClasses: { ...DEFAULT_STUDENT_PREFERENCES.minimizeFridayClasses },
      batchSubjectsToFewerDays: { ...DEFAULT_STUDENT_PREFERENCES.batchSubjectsToFewerDays },
      minimizeExcessiveGaps: { ...DEFAULT_STUDENT_PREFERENCES.minimizeExcessiveGaps },
      starredSectionPreference: { ...DEFAULT_STUDENT_PREFERENCES.starredSectionPreference },
    },
    diversity: { ...DEFAULT_DIVERSITY_CONFIG },
    lastRefreshTime: null,
  };
}
