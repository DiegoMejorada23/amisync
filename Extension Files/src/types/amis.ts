/**
 * Raw AMIS REST API payload contracts matching SPEC.md Section 4.1.
 */

export interface RawAmisTermScheduleResponse {
  nextSchedule?: { term_id: number } | null;
  activeTerm: { term_id: number };
}

export interface RawAmisAuthUserResponse {
  user: {
    id: number | string;
  };
}

export interface RawAmisCourse {
  course_id: number | string;
  course_code: string;
  units: string | number;
  is_multiple_enrollment: boolean;
}

export interface RawAmisCoursesResponse {
  courses: RawAmisCourse[];
}

export interface RawAmisClassDate {
  mon: boolean;
  tue: boolean;
  wed: boolean;
  thu: boolean;
  fri: boolean;
  sat: boolean;
  start_time: string; // "hh:mm AM/PM", e.g., "08:00 AM"
  end_time: string;   // "hh:mm AM/PM", e.g., "09:00 AM"
}

export interface RawAmisFacultyWrapper {
  faculty: {
    user: {
      first_name: string;
      middle_name: string;
      last_name: string;
    };
  };
}

export interface RawAmisClass {
  id: number | string;
  course_id: number | string;
  section: string;
  activity: string; // e.g., "LEC", "LAB", "RECIT", or ""
  hide_faculty: boolean;
  faculties: RawAmisFacultyWrapper[];
  facility_id: string | null;
  class_dates: RawAmisClassDate[];
  active_class_size: number;
  max_class_size: number;
  is_prerog_open: boolean;
  parent_class_id?: number | string | null; // Optional flat FK in snapshots
  parent: RawAmisClass | null;              // Nested parent LEC object in live AMIS API
  course?: RawAmisCourse;                   // Present inside enlistment responses
}

export interface RawAmisClassesResponse {
  classes: RawAmisClass[];
}

export type AmisEnlistmentStatus = 'Bookmarked' | 'Enlisted' | 'Sent to SAIS' | string;

export interface RawStudentEnlistmentClass {
  status: AmisEnlistmentStatus;
  class: RawAmisClass & { course: RawAmisCourse };
}

export interface RawAmisEnlistmentsResponse {
  enlistments: Array<{
    student_enlistment_classes: RawStudentEnlistmentClass[];
  }>;
}
