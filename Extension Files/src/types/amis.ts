/**
 * Raw AMIS REST API payload contracts matching SPEC.md Section 4.1.
 */

export interface RawLaravelPaginator<T> {
  current_page: number;
  data: T[];
  last_page: number;
  total: number;
  per_page?: number;
  from?: number | null;
  to?: number | null;
  next_page_url?: string | null;
  prev_page_url?: string | null;
}

export interface RawAmisTerm {
  id?: number | string;
  term_id?: number | string;
  code?: number | string;
  term_code?: number | string;
  name?: string;
  label?: string;
  description?: string;
  term_name?: string;
  academic_year?: string;
  semester?: string;
  is_active?: boolean;
}

export interface RawAmisTermScheduleItem {
  term_id: number;
  name?: string;
  description?: string;
  term_name?: string;
  academic_year?: string;
  semester?: string;
  term?: RawAmisTerm;
}

export interface RawAmisTermScheduleResponse {
  nextSchedule?: RawAmisTermScheduleItem | null;
  activeTerm: RawAmisTermScheduleItem;
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
  course_title?: string | null;
  title?: string | null;
  subtitle?: string | null;
  description?: string | null;
}

export interface RawAmisCoursesResponse {
  courses: RawAmisCourse[] | RawLaravelPaginator<RawAmisCourse>;
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
  term_id?: number | string;
  section: string;
  activity: string; // e.g., "LEC", "LAB", "RECIT", or ""
  title?: string | null;
  subtitle?: string | null;
  course_subtitle?: string | null;
  course_title?: string | null;
  section_title?: string | null;
  notes?: string | null;
  remarks?: string | null;
  description?: string | null;
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
  classes: RawAmisClass[] | RawLaravelPaginator<RawAmisClass>;
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
