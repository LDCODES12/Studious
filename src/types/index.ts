export interface Course {
  id: string;
  name: string;
  shortName: string;
  instructor: string;
  term: string;
  color: string;
  schedule: string;
  location: string;
  totalAssignments: number;
  completedAssignments: number;
  currentGrade?: string;
  nextClass?: string;
}

export interface Assignment {
  id: string;
  courseId: string;
  title: string;
  description?: string;
  dueDate: string;
  status: "not_started" | "in_progress" | "submitted" | "graded";
  type: "homework" | "quiz" | "exam" | "project" | "reading" | "discussion";
  points?: number;
  earnedPoints?: number;
  week: number;
}

export interface Material {
  id: string;
  courseId: string;
  title: string;
  type: "lecture_slides" | "reading" | "video" | "link" | "handout";
  url?: string;
  week: number;
  uploadedDate: string;
}

export interface WeekData {
  weekNumber: number;
  label: string;
  startDate: string;
  assignments: Assignment[];
  materials: Material[];
}

export interface Task {
  id: string;
  title: string;
  courseId?: string;
  dueDate?: string;
  completed: boolean;
  priority: "low" | "medium" | "high";
}

export interface StudyBuddy {
  id: string;
  name: string;
  avatar?: string;
  sharedCourses: string[];
  availability: string[];
}

export interface ScheduleBlock {
  id: string;
  title: string;
  type: "class" | "study" | "work" | "personal";
  courseId?: string;
  startTime: string;
  endTime: string;
  recurring: boolean;
  days?: number[];
}

export interface SyllabusEvent {
  id: string;
  title: string;
  type: "assignment" | "exam" | "quiz" | "project" | "reading" | "lab" | "other";
  dueDate: string;
  courseName: string;
  description?: string;
  selected: boolean;
}

export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
}
