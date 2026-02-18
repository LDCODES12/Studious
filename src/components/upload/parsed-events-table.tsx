"use client";

import { type SyllabusEvent } from "@/types";
import { format, parseISO } from "date-fns";

interface ParsedEventsTableProps {
  events: SyllabusEvent[];
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}

const typeLabels: Record<SyllabusEvent["type"], string> = {
  assignment: "Assignment",
  exam: "Exam",
  quiz: "Quiz",
  project: "Project",
  reading: "Reading",
  lab: "Lab",
  other: "Other",
};

export function ParsedEventsTable({
  events,
  onToggle,
  onToggleAll,
}: ParsedEventsTableProps) {
  const allSelected = events.every((e) => e.selected);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border bg-accent/30">
            <th className="w-10 px-3 py-2.5 text-left">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                className="accent-foreground"
              />
            </th>
            <th className="px-3 py-2.5 text-left font-medium">Title</th>
            <th className="px-3 py-2.5 text-left font-medium">Type</th>
            <th className="px-3 py-2.5 text-left font-medium">Date</th>
            <th className="px-3 py-2.5 text-left font-medium">Course</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr
              key={event.id}
              className="border-b border-border last:border-0 hover:bg-accent/20"
            >
              <td className="px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={event.selected}
                  onChange={() => onToggle(event.id)}
                  className="accent-foreground"
                />
              </td>
              <td className="px-3 py-2.5">{event.title}</td>
              <td className="px-3 py-2.5 text-muted-foreground">
                {typeLabels[event.type]}
              </td>
              <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                {formatDate(event.dueDate)}
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">
                {event.courseName}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDate(dateStr: string) {
  try {
    return format(parseISO(dateStr), "MMM d, yyyy");
  } catch {
    return dateStr;
  }
}
