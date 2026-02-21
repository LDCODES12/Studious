"use client";

import { useState, useEffect } from "react";
import { format, parseISO, differenceInDays } from "date-fns";
import { ChevronRight, CalendarCheck, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MaterialCard } from "./material-card";
import { MaterialUploader, type UploadedMaterial } from "./material-uploader";
import { QuizSection } from "./quiz-section";
import { GradeBreakdown } from "./grade-breakdown";
import { CourseOverview } from "./course-overview";

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
  missing: boolean;
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
  syllabusDropLowest: number;
  syllabusDropHighest: number;
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
    gradescopeScore: number | null;
    gradescopeMaxScore: number | null;
  }[];
}

interface CourseTask {
  id: string;
  title: string;
  dueDate: string | null;
  priority: string;
  source: string;
}

interface Announcement {
  id: string;
  title: string;
  body: string;
  postedAt: string;
}

interface MaterialCandidate {
  id: string;
  fileName: string;
  moduleName: string;
  requested: boolean;
}

interface CourseTabsProps {
  assignments: Assignment[];
  topics: CourseTopic[];
  materials: CourseMaterial[];
  materialCandidates?: MaterialCandidate[];
  assignmentGroups: AssignmentGroupData[];
  currentGrade: string | null;
  currentScore: number | null;
  gradingScheme: { name: string; value: number }[] | null;
  applyGroupWeights: boolean;
  courseId: string;
  googleConnected: boolean;
  courseTasks: CourseTask[];
  announcements: Announcement[];
}

// ── Type pills ───────────────────────────────────────────────────────────────

const TYPE_PILL: Record<string, { label: string; className: string }> = {
  exam:       { label: "Exam",       className: "bg-red-50 text-red-700" },
  quiz:       { label: "Quiz",       className: "bg-amber-50 text-amber-700" },
  project:    { label: "Project",    className: "bg-purple-50 text-purple-700" },
  lab:        { label: "Lab",        className: "bg-green-50 text-green-700" },
  reading:    { label: "Reading",    className: "bg-gray-100 text-gray-500" },
  assignment: { label: "Assignment", className: "bg-blue-50 text-blue-600" },
};

// ── Status dot & badge ───────────────────────────────────────────────────────

const statusDot: Record<string, string> = {
  not_started: "bg-gray-300",
  in_progress: "bg-blue-500",
  submitted:   "bg-blue-500",
  graded:      "bg-green-500",
};

const statusBadge: Record<string, { label: string; className: string }> = {
  submitted: { label: "Submitted", className: "bg-blue-50 text-blue-600" },
  graded:    { label: "Graded",    className: "bg-green-50 text-green-600" },
};

// ── WeekTopicSection ─────────────────────────────────────────────────────────

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

// ── DeadlinesSection — collapsible section header + rows ────────────────────

function DeadlinesSection({
  label,
  assignments,
  calendarStatuses,
  googleConnected,
  onAddToCalendar,
  defaultOpen = true,
  headerClassName,
}: {
  label: string;
  assignments: Assignment[];
  calendarStatuses: Map<string, "synced" | "missing" | "loading">;
  googleConnected: boolean;
  onAddToCalendar: (id: string) => void;
  defaultOpen?: boolean;
  headerClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (assignments.length === 0) return null;

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "mb-1.5 flex w-full items-center gap-2 text-left",
          headerClassName
        )}
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="text-[12px] font-semibold uppercase tracking-wide">
          {label}
        </span>
        <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {assignments.length}
        </span>
      </button>

      {open && (
        <div className="mb-4 overflow-hidden rounded-lg border border-border bg-card">
          {assignments.map((a, i) => {
            const calStatus = calendarStatuses.get(a.id);
            const pill = TYPE_PILL[a.type] ?? TYPE_PILL.assignment;
            return (
              <div
                key={a.id}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 hover:bg-accent/30",
                  i < assignments.length - 1 ? "border-b border-border" : ""
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
                {/* Score badge for graded items */}
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
                {/* Type pill */}
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                    pill.className
                  )}
                >
                  {pill.label}
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
                        onClick={() => onAddToCalendar(a.id)}
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
    </div>
  );
}

// ── Main CourseTabs export ───────────────────────────────────────────────────

export function CourseTabs({
  assignments,
  topics: initialTopics,
  materials: initialMaterials,
  materialCandidates: initialCandidates = [],
  assignmentGroups,
  currentGrade,
  currentScore,
  gradingScheme,
  applyGroupWeights,
  courseId,
  googleConnected,
  courseTasks,
  announcements,
}: CourseTabsProps) {
  const now = new Date();

  // Partition assignments into sections
  const sorted = [...assignments].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
  });

  const isNeedsAttention = (a: Assignment) => {
    if (a.status === "submitted" || a.status === "graded") return false;
    if (a.missing) return true;
    if (a.dueDate && new Date(a.dueDate) < now) return true;
    return false;
  };

  const needsAttention = sorted.filter(isNeedsAttention);
  const thisWeek = sorted.filter((a) => {
    if (isNeedsAttention(a) || a.status === "submitted" || a.status === "graded") return false;
    if (!a.dueDate) return false;
    const days = differenceInDays(parseISO(a.dueDate), now);
    return days >= 0 && days <= 7;
  });
  const upcoming = sorted.filter((a) => {
    if (isNeedsAttention(a) || a.status === "submitted" || a.status === "graded") return false;
    if (!a.dueDate) return false;
    const days = differenceInDays(parseISO(a.dueDate), now);
    return days > 7;
  });
  const done = sorted.filter(
    (a) => a.status === "submitted" || a.status === "graded"
  );

  const [materials, setMaterials] = useState<CourseMaterial[]>(initialMaterials);
  const [topics, setTopics] = useState<CourseTopic[]>(initialTopics);
  const [candidates, setCandidates] = useState<MaterialCandidate[]>(initialCandidates);
  const [requestingIds, setRequestingIds] = useState<Set<string>>(new Set());
  const [calendarStatuses, setCalendarStatuses] = useState<
    Map<string, "synced" | "missing" | "loading">
  >(new Map());

  const hasStudyMaterials = materials.some((m) => m.storedForAI);

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

  const handleToggleCandidate = async (candidateId: string, requested: boolean) => {
    setRequestingIds((prev) => new Set(prev).add(candidateId));
    try {
      const res = await fetch(`/api/courses/${courseId}/materials/candidates/${candidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requested }),
      });
      if (res.ok) {
        setCandidates((prev) =>
          prev.map((c) => (c.id === candidateId ? { ...c, requested } : c))
        );
      }
    } finally {
      setRequestingIds((prev) => {
        const next = new Set(prev);
        next.delete(candidateId);
        return next;
      });
    }
  };

  const sectionProps = {
    calendarStatuses,
    googleConnected,
    onAddToCalendar: handleAddToCalendar,
  };

  return (
    <Tabs defaultValue="overview">
      <TabsList className="mb-4">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="assignments">Deadlines</TabsTrigger>
        <TabsTrigger value="grades">Grades</TabsTrigger>
        <TabsTrigger value="content">Content</TabsTrigger>
        <TabsTrigger value="materials">Materials</TabsTrigger>
        <TabsTrigger value="quiz">Quiz</TabsTrigger>
      </TabsList>

      {/* ── Overview Tab ── */}
      <TabsContent value="overview">
        <CourseOverview
          assignments={assignments}
          currentGrade={currentGrade}
          currentScore={currentScore}
          applyGroupWeights={applyGroupWeights}
          courseTasks={courseTasks}
          courseId={courseId}
        />
      </TabsContent>

      {/* ── Deadlines Tab ── */}
      <TabsContent value="assignments">
        {sorted.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
            <p className="text-[13px] text-muted-foreground">No assignments yet.</p>
          </div>
        ) : (
          <div>
            <DeadlinesSection
              label="Needs Attention"
              assignments={needsAttention}
              headerClassName="text-red-600"
              {...sectionProps}
            />
            <DeadlinesSection
              label="This Week"
              assignments={thisWeek}
              {...sectionProps}
            />
            <DeadlinesSection
              label="Upcoming"
              assignments={upcoming}
              {...sectionProps}
            />
            <DeadlinesSection
              label="Done"
              assignments={done}
              defaultOpen={false}
              headerClassName="text-muted-foreground"
              {...sectionProps}
            />
            {needsAttention.length === 0 && thisWeek.length === 0 && upcoming.length === 0 && done.length === 0 && (
              <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
                <p className="text-[13px] text-muted-foreground">No assignments.</p>
              </div>
            )}
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
        <div className="space-y-6">
          {/* Uploaded materials */}
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

          {/* From Canvas — candidates grouped by module */}
          {candidates.length > 0 && (
            <div className="space-y-3">
              <div>
                <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                  From Canvas
                </p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  Files available on Canvas. Click Add to import on your next sync.
                </p>
              </div>
              {/* Group by module */}
              {(() => {
                const byModule = candidates.reduce<Record<string, MaterialCandidate[]>>(
                  (acc, c) => {
                    (acc[c.moduleName] ??= []).push(c);
                    return acc;
                  },
                  {}
                );
                return Object.entries(byModule).map(([moduleName, items]) => (
                  <div key={moduleName} className="rounded-lg border border-border bg-card">
                    <div className="border-b border-border px-4 py-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {moduleName}
                      </p>
                    </div>
                    <div className="divide-y divide-border">
                      {items.map((c) => (
                        <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                          <span className="min-w-0 flex-1 truncate text-[13px]">{c.fileName}</span>
                          {c.requested ? (
                            <div className="flex shrink-0 items-center gap-2">
                              <span className="text-[11px] text-amber-600">
                                Queued for next sync
                              </span>
                              <button
                                onClick={() => handleToggleCandidate(c.id, false)}
                                disabled={requestingIds.has(c.id)}
                                className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleToggleCandidate(c.id, true)}
                              disabled={requestingIds.has(c.id)}
                              className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-accent disabled:opacity-50"
                            >
                              {requestingIds.has(c.id) ? "..." : "Add"}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ));
              })()}
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
