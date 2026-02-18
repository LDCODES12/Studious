import { format, parseISO } from "date-fns";
import { type Assignment } from "@/types";

const statusDot: Record<Assignment["status"], string> = {
  not_started: "bg-gray-300",
  in_progress: "bg-blue-500",
  submitted: "bg-green-500",
  graded: "bg-green-500",
};

interface AssignmentRowProps {
  assignment: Assignment;
}

export function AssignmentRow({ assignment }: AssignmentRowProps) {
  const dueDate = format(parseISO(assignment.dueDate), "MMM d");

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/30">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot[assignment.status]}`} />
      <span className="min-w-0 flex-1 truncate text-[13px]">
        {assignment.title}
      </span>
      {assignment.points && (
        <span className="shrink-0 text-[12px] text-muted-foreground">
          {assignment.points} pts
        </span>
      )}
      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
        {dueDate}
      </span>
      {assignment.status === "graded" && assignment.earnedPoints !== undefined && (
        <span className="shrink-0 text-[12px] font-medium text-green-600">
          {assignment.earnedPoints}/{assignment.points}
        </span>
      )}
    </div>
  );
}
