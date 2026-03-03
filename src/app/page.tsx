import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { GreetingBanner } from "@/components/dashboard/greeting-banner";
import { CourseGrid } from "@/components/dashboard/course-grid";
import { UpcomingDeadlines } from "@/components/dashboard/upcoming-deadlines";
import { TodayTasks } from "@/components/dashboard/today-tasks";
import { PreClassCard } from "@/components/reflections/pre-class-card";
import { LearningPulse } from "@/components/dashboard/learning-pulse";
import { WhatsWorking } from "@/components/dashboard/whats-working";
import { computeCourseContext } from "@/lib/course-context";
import { computeLearningSignals } from "@/lib/learning-signals";
import { computeInterventionOutcomes } from "@/lib/intervention-outcomes";
import { SyncStatusBanner } from "@/components/dashboard/sync-status-banner";
import { WeekOverview } from "@/components/dashboard/week-overview";
import { getOrCreateWeekOverview, buildWeekDays } from "@/lib/week-overview";
import type { ExtractedClassSchedule } from "@/lib/parse-syllabus";

export default async function DashboardPage() {
  const session = await auth();
  const userId = session?.user?.id;

  const today = new Date().toISOString().slice(0, 10);
  const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [courses, tasks, learningSignals, interventionOutcomes, userStatus, todayPreClassReflections] = await Promise.all([
    userId
      ? db.course.findMany({
          where: { userId },
          include: {
            assignments: { orderBy: { dueDate: "asc" } },
            topics: {
              orderBy: { weekNumber: "asc" },
              select: {
                weekNumber: true,
                weekLabel: true,
                startDate: true,
                topics: true,
                readings: true,
                completedTopics: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        })
      : [],
    userId
      ? db.task.findMany({
          where: {
            userId,
            completed: false,
            dueDate: { gte: today, lte: threeDaysFromNow },
          },
          include: {
            course: { select: { id: true, shortName: true, color: true } },
          },
          orderBy: { dueDate: "asc" },
          take: 6,
        })
      : [],
    userId ? computeLearningSignals(userId) : null,
    userId ? computeInterventionOutcomes(userId) : null,
    userId
      ? db.user.findUnique({
          where: { id: userId },
          select: { bgSyncProcessingAt: true },
        })
      : null,
    userId
      ? db.reflection.findMany({
          where: {
            userId,
            type: "pre_class",
            createdAt: { gte: todayStart },
          },
          select: { courseId: true },
        })
      : [],
  ]);

  const assignments = (courses as Awaited<typeof courses>).flatMap((c) =>
    c.assignments.map((a) => ({ ...a, course: c }))
  );

  const dashboardTasks = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    dueDate: t.dueDate,
    completed: t.completed,
    priority: t.priority,
    source: t.source,
    course: t.course,
  }));

  // Compute course contexts for each course
  const courseContexts = courses.map((course) => {
    const ctx = computeCourseContext({
      id: course.id,
      name: course.name,
      shortName: course.shortName,
      color: course.color,
      currentGrade: course.currentGrade,
      currentScore: course.currentScore,
      classSchedule: course.classSchedule as ExtractedClassSchedule | null,
      topics: course.topics,
      assignments: course.assignments.map((a) => ({
        title: a.title,
        type: a.type,
        dueDate: a.dueDate,
        status: a.status,
        pointsPossible: a.pointsPossible,
        omitFromFinalGrade: a.omitFromFinalGrade,
      })),
    });

    return {
      course: {
        id: course.id,
        name: course.name,
        color: course.color,
        currentGrade: course.currentGrade,
        currentScore: course.currentScore,
      },
      context: ctx,
      classSchedule: course.classSchedule as ExtractedClassSchedule | null,
    };
  });

  // Week overview — AI-generated, cached per week
  const weekOverview = userId && courseContexts.length > 0
    ? await getOrCreateWeekOverview(userId, courseContexts, learningSignals)
    : null;
  const weekDays = courseContexts.length > 0 ? buildWeekDays(courseContexts) : [];

  // Pre-class prompts from course contexts
  const isSemanticTopic = (name: string) =>
    !/^(Lecture|Module|Week|Unit|Chapter|Session|Class)\s*\d+$/i.test(name);

  const answeredCourseIds = new Set(
    todayPreClassReflections.map((r) => r.courseId).filter(Boolean)
  );

  const preClassPrompts = courseContexts
    .map(({ course, context }) => {
      if (!context.nextClassMeeting) return null;
      if (answeredCourseIds.has(course.id)) return null;

      const semanticCurrent = (context.currentWeek?.topics ?? []).filter(isSemanticTopic);
      const semanticNext = (context.nextWeek?.topics ?? []).filter(isSemanticTopic);
      const topicName = semanticCurrent[0] ?? semanticNext[0] ?? null;

      return {
        courseId: course.id,
        courseName: course.name,
        courseColor: course.color,
        topicName,
        classTime: context.nextClassMeeting,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  const isSyncProcessing =
    !!userStatus?.bgSyncProcessingAt &&
    Date.now() - new Date(userStatus.bgSyncProcessingAt).getTime() < 10 * 60 * 1000;

  return (
    <div className="space-y-7">
      <GreetingBanner name={session?.user?.name ?? "there"} />
      <SyncStatusBanner initialProcessing={isSyncProcessing} />

      {/* Week overview — AI-generated timeline */}
      {weekOverview && weekDays.length > 0 && (
        <WeekOverview overview={weekOverview} days={weekDays} />
      )}

      {/* Pre-class prompts — most time-sensitive, shown first */}
      {preClassPrompts.length > 0 && (
        <div className={preClassPrompts.length > 1 ? "grid grid-cols-2 gap-3" : ""}>
          {preClassPrompts.map((prompt) => (
            <PreClassCard key={prompt.courseId} {...prompt} />
          ))}
        </div>
      )}

      {/* Tasks due soon */}
      <TodayTasks initialTasks={dashboardTasks} />

      {/* Course grid with context-rich cards */}
      <CourseGrid courses={courseContexts} />

      {/* Conditional learning nudge */}
      {learningSignals && <LearningPulse signals={learningSignals} />}

      {/* What's working */}
      {interventionOutcomes && <WhatsWorking outcomes={interventionOutcomes} hasCourses={courses.length > 0} />}

      {/* Upcoming deadlines */}
      <UpcomingDeadlines assignments={assignments} />
    </div>
  );
}
