import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { computeCourseContext } from "@/lib/course-context";
import type { ExtractedClassSchedule } from "@/lib/parse-syllabus";
import { StudyToolsClient } from "@/components/study-tools/study-tools-client";
import type { TutorTopic } from "@/components/study-tools/tutor-topic-picker";

export default async function StudyToolsPage() {
  const session = await auth();
  const userId = session?.user?.id;

  // Fetch courses with topics to compute current week
  const courses = userId
    ? await db.course.findMany({
        where: { userId },
        select: {
          id: true,
          name: true,
          shortName: true,
          color: true,
          currentGrade: true,
          currentScore: true,
          classSchedule: true,
          topics: {
            orderBy: { weekNumber: "asc" },
            select: {
              weekNumber: true,
              weekLabel: true,
              startDate: true,
              topics: true,
              readings: true,
              notes: true,
              completedTopics: true,
            },
          },
          assignments: {
            where: { omitFromFinalGrade: false },
            orderBy: { dueDate: "asc" },
            select: {
              title: true,
              type: true,
              dueDate: true,
              status: true,
              pointsPossible: true,
              omitFromFinalGrade: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      })
    : [];

  // Extract current week topics for tutor topic picker
  const isSemanticTopic = (name: string) =>
    !/^(Lecture|Module|Week|Unit|Chapter|Session|Class)\s*\d+$/i.test(name);

  const tutorTopics: TutorTopic[] = [];

  for (const course of courses) {
    const ctx = computeCourseContext({
      ...course,
      classSchedule: course.classSchedule as ExtractedClassSchedule | null,
    });

    if (ctx.currentWeek) {
      const semanticTopics = ctx.currentWeek.topics.filter(isSemanticTopic);
      for (const topicName of semanticTopics.slice(0, 3)) {
        tutorTopics.push({
          courseId: course.id,
          courseName: course.name,
          courseColor: course.color,
          topicName,
          readings: ctx.currentWeek.readings,
        });
      }
    }
  }

  return <StudyToolsClient tutorTopics={tutorTopics} />;
}
