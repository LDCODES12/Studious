export interface Assignment {
  id: string;
  title: string;
  dueDate: string | null;
  type: string;
  status: string;
  course: {
    id: string;
    name: string;
    shortName: string | null;
    color: string;
  };
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
}

export interface CourseRef {
  id: string;
  name: string;
  shortName: string | null;
  color: string;
}

export interface Suggestion {
  day: string;
  time: string;
  task: string;
  reason: string;
}

export type ViewMode = "month" | "week";

export type ScheduleItem = Assignment | CalendarEvent;

export function isAssignment(item: ScheduleItem): item is Assignment {
  return "course" in item;
}
