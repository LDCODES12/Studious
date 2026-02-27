import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { GreetingBanner } from "@/components/dashboard/greeting-banner";
import { QuickStats } from "@/components/dashboard/quick-stats";
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
import type { ExtractedClassSchedule } from "@/lib/parse-syllabus";

export default async function DashboardPage() {
  const session = await auth();
  const userId = session?.user?.id;

  const today = new Date().toISOString().slice(0, 10);
  const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const [courses, tasks, learningSignals, interventionOutcomes, userStatus] = await Promise.all([
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

  // Compute pre-class prompts for courses with class today
  const preClassPrompts = courses
    .map((course) => {
      const ctx = computeCourseContext(
        {
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
        }
      );

      if (!ctx.nextClassMeeting) return null;

      // Filter out generic module labels like "Lecture 5", "Module 3"
      const isSemanticTopic = (name: string) =>
        !/^(Lecture|Module|Week|Unit|Chapter|Session|Class)\s*\d+$/i.test(name);

      const semanticCurrent = (ctx.currentWeek?.topics ?? []).filter(isSemanticTopic);
      const semanticNext = (ctx.nextWeek?.topics ?? []).filter(isSemanticTopic);
      const topicName = semanticCurrent[0] ?? semanticNext[0] ?? null;

      // Show card even without a topic — generic "how prepared?" prompt
      return {
        courseId: course.id,
        courseName: course.shortName ?? course.name,
        courseColor: course.color,
        topicName,
        classTime: ctx.nextClassMeeting,
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
      <QuickStats courses={courses} assignments={assignments} />
      {learningSignals && <LearningPulse signals={learningSignals} />}
      {interventionOutcomes && <WhatsWorking outcomes={interventionOutcomes} hasCourses={courses.length > 0} />}
      <div className="grid grid-cols-5 gap-7">
        <div className="col-span-3">
          <CourseGrid courses={courses} />
        </div>
        <div className="col-span-2 space-y-7">
          {preClassPrompts.map((prompt) => (
            <PreClassCard key={prompt.courseId} {...prompt} />
          ))}
          <TodayTasks initialTasks={dashboardTasks} />
          <UpcomingDeadlines assignments={assignments} />
        </div>
      </div>
    </div>
  );
}
