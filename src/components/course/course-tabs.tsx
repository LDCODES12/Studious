"use client";

import { useState, useEffect } from "react";
import { format, parseISO } from "date-fns";
import { ChevronRight, CalendarCheck, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MaterialCard } from "./material-card";
import { MaterialUploader, type UploadedMaterial } from "./material-uploader";
import { QuizSection } from "./quiz-section";
import { GradeBreakdown } from "./grade-breakdown";

interface Assignment {
  id: string;
  title: string;
  dueDate: string | null;
  status: string;
  type: string;
  googleEventId: string | null;
  courseId: string;
  score: number | null;
  pointsPossible: number | null;
  canvasUrl: string | null;
}

interface CourseTopic {
  id: string;
  weekNumber: number;
  weekLabel: string;
  startDate: string | null;
  topics: string[];
  readings: string[];
  notes: string | null;
  completedTopics: string[];
}

interface CourseMaterial {
  id: string;
  fileName: string;
  detectedType: string;
  summary: string;
  relatedTopics: string[];
  storedForAI: boolean;
  uploadedAt: string;
}

interface AssignmentGroupData {
  id: string;
  name: string;
  weight: number;
  position: number;
  dropLowest: number;
  dropHighest: number;
  neverDrop: string[];
  assignments: {
    id: string;
    title: string;
    score: number | null;
    pointsPossible: number | null;
    status: string;
    dueDate: string | null;
    excused: boolean;
    omitFromFinalGrade: boolean;
    canvasAssignmentId: string | null;
    missing: boolean;
    late: boolean;
  }[];
}

interface CourseTabsProps {
  assignments: Assignment[];
  topics: CourseTopic[];
  materials: CourseMaterial[];
  assignmentGroups: AssignmentGroupData[];
  currentGrade: string | null;
  currentScore: number | null;
  gradingScheme: { name: string; value: number }[] | null;
  applyGroupWeights: boolean;
  courseId: string;
  googleConnected: boolean;
}

const statusDot: Record<string, string> = {
  not_started: "bg-gray-300",
  in_progress: "bg-blue-500",
  submitted: "bg-blue-500",
  graded: "bg-green-500",
};

const statusBadge: Record<string, { label: string; className: string }> = {
  submitted: { label: "Submitted", className: "bg-blue-50 text-blue-600" },
  graded: { label: "Graded", className: "bg-green-50 text-green-600" },
};

function WeekTopicSection({
  topic,
  courseId,
  onProgressUpdate,
}: {
  topic: CourseTopic;
  courseId: string;
  onProgressUpdate: (topicId: string, completed: string[]) => void;
}) {
  const [open, setOpen] = useState(topic.weekNumber <= 2);
  const [completed, setCompleted] = useState<Set<string>>(new Set(topic.completedTopics));
  const [saving, setSaving] = useState(false);

  const toggleTopic = async (t: string) => {
    const next = new Set(completed);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setCompleted(next);
    setSaving(true);
    try {
      await fetch(`/api/courses/${courseId}/topics/${topic.id}/progress`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completedTopics: Array.from(next) }),
      });
      onProgressUpdate(topic.id, Array.from(next));
    } finally {
      setSaving(false);
    }
  };

  const doneCount = completed.size;
  const totalCount = topic.topics.length;

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
        {totalCount > 0 && (
          <span
            className={cn(
              "ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium",
              doneCount === totalCount
                ? "bg-green-100 text-green-700"
                : doneCount > 0
                ? "bg-blue-50 text-blue-600"
                : "bg-gray-100 text-gray-500"
            )}
          >
            {doneCount}/{totalCount}
          </span>
        )}
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
                {topic.topics.map((t, i) => {
                  const done = completed.has(t);
                  return (
                    <li key={i} className="flex items-start gap-2">
                      <button
                        onClick={() => toggleTopic(t)}
                        disabled={saving}
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                          done
                            ? "border-green-500 bg-green-500 text-white"
                            : "border-border hover:border-foreground/40"
                        )}
                      >
                        {done && <Check className="h-2.5 w-2.5" />}
                      </button>
                      <span
                        className={cn(
                          "text-[13px] leading-snug",
                          done && "text-muted-foreground line-through decoration-muted-foreground/40"
                        )}
                      >
                        {t}
                      </span>
                    </li>
                  );
                })}
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
  topics: initialTopics,
  materials: initialMaterials,
  assignmentGroups,
  currentGrade,
  currentScore,
  gradingScheme,
  applyGroupWeights,
  courseId,
  googleConnected,
}: CourseTabsProps) {
  const sorted = [...assignments].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
  });

  const [materials, setMaterials] = useState<CourseMaterial[]>(initialMaterials);
  const [topics, setTopics] = useState<CourseTopic[]>(initialTopics);
  const [calendarStatuses, setCalendarStatuses] = useState<
    Map<string, "synced" | "missing" | "loading">
  >(new Map());

  const hasStudyMaterials = materials.some((m) => m.storedForAI);

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

  const handleProgressUpdate = (topicId: string, completed: string[]) => {
    setTopics((prev) =>
      prev.map((t) => (t.id === topicId ? { ...t, completedTopics: completed } : t))
    );
  };

  return (
    <Tabs defaultValue="assignments">
      <TabsList className="mb-4">
        <TabsTrigger value="assignments">Deadlines</TabsTrigger>
        <TabsTrigger value="grades">Grades</TabsTrigger>
        <TabsTrigger value="content">Content</TabsTrigger>
        <TabsTrigger value="materials">Materials</TabsTrigger>
        <TabsTrigger value="quiz">Quiz</TabsTrigger>
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
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {a.canvasUrl ? (
                      <a
                        href={a.canvasUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        {a.title}
                      </a>
                    ) : (
                      a.title
                    )}
                  </span>
                  {statusBadge[a.status] && (
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                        statusBadge[a.status].className
                      )}
                    >
                      {a.status === "graded" && a.score != null && a.pointsPossible
                        ? `${a.score}/${a.pointsPossible}`
                        : statusBadge[a.status].label}
                    </span>
                  )}
                  <span className="shrink-0 text-[12px] capitalize text-muted-foreground">
                    {a.type.replace(/_/g, " ")}
                  </span>
                  <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                    {a.dueDate ? format(parseISO(a.dueDate), "MMM d") : "No date"}
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

      {/* ── Grades Tab ── */}
      <TabsContent value="grades">
        <GradeBreakdown
          assignmentGroups={assignmentGroups}
          currentGrade={currentGrade}
          currentScore={currentScore}
          gradingScheme={gradingScheme}
          applyGroupWeights={applyGroupWeights}
        />
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
              <WeekTopicSection
                key={topic.id}
                topic={topic}
                courseId={courseId}
                onProgressUpdate={handleProgressUpdate}
              />
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

      {/* ── Quiz Tab ── */}
      <TabsContent value="quiz">
        <QuizSection courseId={courseId} hasStudyMaterials={hasStudyMaterials} />
      </TabsContent>
    </Tabs>
  );
}
