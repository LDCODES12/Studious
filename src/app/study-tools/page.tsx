import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { StudyToolsClient } from "@/components/study-tools/study-tools-client";
import type { TutorTopic } from "@/components/study-tools/tutor-topic-picker";
import { buildStudyTargets } from "@/lib/study-targets";

export default async function StudyToolsPage() {
  const session = await auth();
  const userId = session?.user?.id;

  // Fetch courses with nearby timeline context and stored materials for study-target ranking.
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
              dateConfidence: true,
              contentConfidence: true,
              scheduleMode: true,
              provenance: true,
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
          materials: {
            select: {
              id: true,
              fileName: true,
              detectedType: true,
              sourceKind: true,
              relatedTopics: true,
              sourceUpdatedAt: true,
              uploadedAt: true,
            },
          },
          materialCandidates: {
            select: {
              id: true,
              fileName: true,
              moduleName: true,
              remoteUpdatedAt: true,
              lastSeenAt: true,
              requested: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const tutorTopics: TutorTopic[] = courses.flatMap((course) => buildStudyTargets(course));

  return <StudyToolsClient tutorTopics={tutorTopics} />;
}
