import { courseColors } from "@/lib/constants";
import { formatDistanceToNow, parseISO } from "date-fns";

interface Assignment {
  id: string;
  title: string;
  dueDate: string | null;
  status: string;
  course: { shortName: string | null; color: string };
}

export function UpcomingDeadlines({ assignments }: { assignments: Assignment[] }) {
  const upcoming = assignments
    .filter((a) => a.status === "not_started" && a.dueDate && new Date(a.dueDate) >= new Date())
    .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime())
    .slice(0, 6);

  if (upcoming.length === 0) {
    return (
      <div>
        <h2 className="mb-4 text-[14px] font-semibold">Upcoming</h2>
        <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
          <p className="text-[13px] text-muted-foreground">No upcoming deadlines.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-4 text-[14px] font-semibold">Upcoming</h2>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {upcoming.map((assignment, i) => {
          const colors = courseColors[assignment.course.color ?? "blue"];
          const due = assignment.dueDate ? formatDistanceToNow(parseISO(assignment.dueDate), { addSuffix: true }) : "";

          return (
            <div
              key={assignment.id}
              className={`flex items-center gap-3 px-4 py-3 ${
                i < upcoming.length - 1 ? "border-b border-border" : ""
              }`}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${colors?.dot ?? "bg-gray-400"}`} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{assignment.title}</p>
                <p className="text-[11px] text-muted-foreground">
                  {assignment.course.shortName ?? ""}
                </p>
              </div>
              <span className="shrink-0 text-[12px] text-muted-foreground">{due}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
