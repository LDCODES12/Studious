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
import { getOrCreateWeekOverview, buildWeekCourses, applyDetectedTermBreaks } from "@/lib/week-overview";
import type { ExtractedClassSchedule } from "@/lib/parse-syllabus";
import { getRecentCourseActivity } from "@/lib/recent-course-activity";

export default async function DashboardPage() {
  const session = await auth();
  const userId = session?.user?.id;
  const now = new Date();

  const easternDateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const formatEasternDate = (date: Date) => {
    const parts = easternDateFormatter.formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  };

  const today = formatEasternDate(now);
  const threeDaysFromNow = formatEasternDate(new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000));
  const dashboardCalendarNow = new Date(`${today}T12:00:00Z`);

  const todayStart = new Date(now);
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
                notes: true,
                dateConfidence: true,
                contentConfidence: true,
                scheduleMode: true,
                provenance: true,
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
        term: course.term,
        color: course.color,
        currentGrade: course.currentGrade,
        currentScore: course.currentScore,
      },
      context: ctx,
      classSchedule: course.classSchedule as ExtractedClassSchedule | null,
    };
  });

  const normalizedCourseContexts = applyDetectedTermBreaks(courseContexts, dashboardCalendarNow);
  const recentActivityByCourse = await getRecentCourseActivity(courses.map((course) => course.id));

  // Week overview — AI-generated, cached per week
  const weekOverview = userId && normalizedCourseContexts.length > 0
    ? await getOrCreateWeekOverview(userId, normalizedCourseContexts, learningSignals, dashboardCalendarNow)
    : null;
  const weekCourses = normalizedCourseContexts.length > 0 ? buildWeekCourses(normalizedCourseContexts, dashboardCalendarNow) : [];

  // Pre-class prompts from course contexts
  const isSemanticTopic = (name: string) =>
    !/^(Lecture|Module|Week|Unit|Chapter|Session|Class)\s*\d+$/i.test(name);

  const answeredCourseIds = new Set(
    todayPreClassReflections.map((r) => r.courseId).filter(Boolean)
  );

  const preClassPrompts = normalizedCourseContexts
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
    now.getTime() - new Date(userStatus.bgSyncProcessingAt).getTime() < 10 * 60 * 1000;

  return (
    <div className="space-y-7">
      <GreetingBanner name={session?.user?.name ?? "there"} />
      <SyncStatusBanner initialProcessing={isSyncProcessing} />

      {/* Week overview — AI-generated timeline */}
      {weekOverview && weekCourses.length > 0 && (
        <WeekOverview overview={weekOverview} courses={weekCourses} />
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
      <CourseGrid courses={normalizedCourseContexts} recentActivityByCourse={recentActivityByCourse} />

      {/* Conditional learning nudge */}
      {learningSignals && <LearningPulse signals={learningSignals} />}

      {/* What's working */}
      {interventionOutcomes && <WhatsWorking outcomes={interventionOutcomes} hasCourses={courses.length > 0} />}

      {/* Upcoming deadlines */}
      <UpcomingDeadlines assignments={assignments} />
    </div>
  );
}
