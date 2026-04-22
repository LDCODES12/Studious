import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { StudyToolsClient } from "@/components/study-tools/study-tools-client";
import type {
  RecentTutorConversationSummary,
  TutorTopic,
} from "@/components/study-tools/tutor-topic-picker";
import { buildStudyTargets } from "@/lib/study-targets";

function formatRecentActivityLabel(date: Date): string {
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const dayDelta = Math.floor(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) /
      dayMs
  );

  if (dayDelta <= 0) return "Today";
  if (dayDelta === 1) return "Yesterday";
  if (dayDelta < 7) return `${dayDelta}d ago`;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);
}

function buildRecentTutorConversationSummaries(
  conversations: Array<{
    id: string;
    courseId: string | null;
    topicName: string | null;
    title: string;
    preview: string | null;
    lastMessageAt: Date;
    course: { name: string; color: string } | null;
  }>
): RecentTutorConversationSummary[] {
  return conversations.map((conversation) => ({
    id: conversation.id,
    conversationId: conversation.id,
    courseId: conversation.courseId ?? undefined,
    courseName: conversation.course?.name ?? undefined,
    courseColor: conversation.course?.color ?? undefined,
    topicName: conversation.topicName ?? undefined,
    title: conversation.title,
    preview:
      conversation.preview ??
      (conversation.topicName
        ? `Pick up ${conversation.topicName}.`
        : conversation.course?.name
          ? `Jump back into ${conversation.course.name}.`
          : "Open your latest tutor thread."),
    updatedAtLabel: formatRecentActivityLabel(conversation.lastMessageAt),
  }));
}

export default async function StudyToolsPage() {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return <StudyToolsClient tutorTopics={[]} recentTutorConversations={[]} />;
  }

  const [courses, recentTutorConversationRows] = await Promise.all([
    // Fetch courses with nearby timeline context and stored materials for study-target ranking.
    db.course.findMany({
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
          where: {
            sourceKind: {
              notIn: ["canvas_page", "canvas_syllabus_page", "canvas_announcement"],
            },
          },
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
    }),
    db.tutorConversation.findMany({
      where: {
        userId,
      },
      select: {
        id: true,
        courseId: true,
        topicName: true,
        title: true,
        preview: true,
        lastMessageAt: true,
        course: {
          select: {
            name: true,
            color: true,
          },
        },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 6,
    }),
  ]);
  const recentTutorConversations = buildRecentTutorConversationSummaries(
    recentTutorConversationRows
  );

  const tutorTopics: TutorTopic[] = courses.flatMap((course) => buildStudyTargets(course));

  return (
    <StudyToolsClient
      tutorTopics={tutorTopics}
      recentTutorConversations={recentTutorConversations}
    />
  );
}
