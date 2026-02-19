"use client";

import { useState, useEffect } from "react";
import { format, parseISO } from "date-fns";
import { ChevronRight, CalendarCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MaterialCard } from "./material-card";
import { MaterialUploader, type UploadedMaterial } from "./material-uploader";

interface Assignment {
  id: string;
  title: string;
  dueDate: string;
  status: string;
  type: string;
  googleEventId: string | null;
  courseId: string;
}

interface CourseTopic {
  id: string;
  weekNumber: number;
  weekLabel: string;
  startDate: string | null;
  topics: string[];
  readings: string[];
  notes: string | null;
}

interface CourseMaterial {
  id: string;
  fileName: string;
  detectedType: string;
  summary: string;
  relatedTopics: string[];
  uploadedAt: string;
}

interface CourseTabsProps {
  assignments: Assignment[];
  topics: CourseTopic[];
  materials: CourseMaterial[];
  courseId: string;
  googleConnected: boolean;
}

const statusDot: Record<string, string> = {
  not_started: "bg-gray-300",
  in_progress: "bg-blue-500",
  submitted: "bg-green-500",
  graded: "bg-green-500",
};

function WeekTopicSection({ topic }: { topic: CourseTopic }) {
  const [open, setOpen] = useState(topic.weekNumber <= 2);

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-accent/30"
      >
        <ChevronRight
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="text-[13px] font-medium">Week {topic.weekNumber}</span>
        <span className="text-[13px] text-muted-foreground">· {topic.weekLabel}</span>
        {topic.startDate && (
          <span className="ml-auto text-[12px] text-muted-foreground">
            {format(parseISO(topic.startDate), "MMM d")}
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-4 py-3">
          {topic.topics.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Topics
              </p>
              <ul className="space-y-1">
                {topic.topics.map((t, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px]">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-foreground/40" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {topic.readings.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Readings
              </p>
              <ul className="space-y-1">
                {topic.readings.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-muted-foreground">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" />
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {topic.notes && (
            <p className="text-[12px] italic text-muted-foreground">{topic.notes}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function CourseTabs({
  assignments,
  topics,
  materials: initialMaterials,
  courseId,
  googleConnected,
}: CourseTabsProps) {
  const sorted = [...assignments].sort(
    (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
  );

  const [materials, setMaterials] = useState<CourseMaterial[]>(initialMaterials);
  const [calendarStatuses, setCalendarStatuses] = useState<
    Map<string, "synced" | "missing" | "loading">
  >(new Map());

  // Initialize and fetch calendar statuses
  useEffect(() => {
    if (!googleConnected || assignments.length === 0) return;

    const initial = new Map<string, "synced" | "missing" | "loading">();
    for (const a of assignments) {
      initial.set(a.id, a.googleEventId ? "loading" : "missing");
    }
    setCalendarStatuses(initial);

    const hasEvents = assignments.some((a) => a.googleEventId);
    if (!hasEvents) return;

    fetch(`/api/courses/${courseId}/calendar-status`)
      .then((r) => r.json())
      .then((data: { statuses: { assignmentId: string; exists: boolean }[] }) => {
        setCalendarStatuses((prev) => {
          const next = new Map(prev);
          for (const s of data.statuses) {
            next.set(s.assignmentId, s.exists ? "synced" : "missing");
          }
          return next;
        });
      })
      .catch(() => {
        setCalendarStatuses((prev) => {
          const next = new Map(prev);
          for (const [id, status] of next) {
            if (status === "loading") next.set(id, "missing");
          }
          return next;
        });
      });
  }, [courseId, googleConnected, assignments]);

  const handleAddToCalendar = async (assignmentId: string) => {
    setCalendarStatuses((prev) => new Map(prev).set(assignmentId, "loading"));
    try {
      const res = await fetch(`/api/assignments/${assignmentId}/calendar-sync`, {
        method: "POST",
      });
      setCalendarStatuses((prev) =>
        new Map(prev).set(assignmentId, res.ok ? "synced" : "missing")
      );
    } catch {
      setCalendarStatuses((prev) => new Map(prev).set(assignmentId, "missing"));
    }
  };

  const handleUploadComplete = (material: UploadedMaterial) => {
    setMaterials((prev) => [material, ...prev]);
  };

  return (
    <Tabs defaultValue="assignments">
      <TabsList className="mb-4">
        <TabsTrigger value="assignments">Deadlines</TabsTrigger>
        <TabsTrigger value="content">Content</TabsTrigger>
        <TabsTrigger value="materials">Materials</TabsTrigger>
      </TabsList>

      {/* ── Deadlines Tab ── */}
      <TabsContent value="assignments">
        {sorted.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
            <p className="text-[13px] text-muted-foreground">No assignments yet.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {sorted.map((a, i) => {
              const calStatus = calendarStatuses.get(a.id);
              return (
                <div
                  key={a.id}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 hover:bg-accent/30",
                    i < sorted.length - 1 ? "border-b border-border" : ""
                  )}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      statusDot[a.status] ?? "bg-gray-300"
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{a.title}</span>
                  <span className="shrink-0 text-[12px] capitalize text-muted-foreground">
                    {a.type.replace(/_/g, " ")}
                  </span>
                  <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                    {format(parseISO(a.dueDate), "MMM d")}
                  </span>
                  {googleConnected && (
                    <div className="w-20 shrink-0 text-right">
                      {calStatus === "loading" && (
                        <span className="text-[11px] text-muted-foreground">...</span>
                      )}
                      {calStatus === "synced" && (
                        <CalendarCheck className="ml-auto h-3.5 w-3.5 text-green-500" />
                      )}
                      {calStatus === "missing" && (
                        <button
                          onClick={() => handleAddToCalendar(a.id)}
                          className="text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          + Calendar
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </TabsContent>

      {/* ── Content Tab ── */}
      <TabsContent value="content">
        {topics.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
            <p className="text-[13px] text-muted-foreground">
              Upload your syllabus to populate the content timeline.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {topics.map((topic) => (
              <WeekTopicSection key={topic.id} topic={topic} />
            ))}
          </div>
        )}
      </TabsContent>

      {/* ── Materials Tab ── */}
      <TabsContent value="materials">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <p className="text-[13px] text-muted-foreground">
              Upload course PDFs — AI will classify and map them to your content timeline.
            </p>
            <MaterialUploader courseId={courseId} onUploadComplete={handleUploadComplete} />
          </div>
          {materials.length === 0 ? (
            <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
              <p className="text-[13px] text-muted-foreground">No files uploaded yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {materials.map((m) => (
                <MaterialCard key={m.id} material={m} />
              ))}
            </div>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}
