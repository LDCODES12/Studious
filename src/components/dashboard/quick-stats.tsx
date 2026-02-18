import { isThisWeek, parseISO } from "date-fns";

interface Props {
  courses: { id: string }[];
  assignments: { status: string; dueDate: string }[];
}

export function QuickStats({ courses, assignments }: Props) {
  const dueThisWeek = assignments.filter(
    (a) => a.status === "not_started" && isThisWeek(parseISO(a.dueDate))
  ).length;

  const upcoming = assignments.filter(
    (a) => a.status === "not_started" && new Date(a.dueDate) >= new Date()
  ).length;

  const stats = [
    { label: "Courses", value: courses.length || "—" },
    { label: "Assignments", value: assignments.length || "—" },
    { label: "Due this week", value: dueThisWeek || "—" },
    { label: "Upcoming", value: upcoming || "—" },
  ];

  return (
    <div className="grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-border bg-border">
      {stats.map((stat) => (
        <div key={stat.label} className="bg-card px-5 py-4">
          <p className="text-[12px] text-muted-foreground">{stat.label}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{stat.value}</p>
        </div>
      ))}
    </div>
  );
}
