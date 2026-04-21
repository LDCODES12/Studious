import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import type { StudyTargetEvidence } from "@/lib/study-targets";
import {
  buildTutorConversationDetail,
  buildTutorConversationSummary,
} from "@/lib/tutor-conversations";
import { TutorSession } from "@/components/study-tools/tutor-session";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function getFirstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseEvidence(raw: string | undefined): StudyTargetEvidence | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as StudyTargetEvidence;
  } catch {
    return undefined;
  }
}

export default async function TutorPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const session = await auth();
  const userId = session?.user?.id;

  const conversationId = getFirstParam(params.conversationId);
  const requestedCourseId = getFirstParam(params.courseId);
  const requestedTopicName = getFirstParam(params.topic);
  const requestedPrompt = getFirstParam(params.q);
  const requestedCourseName = getFirstParam(params.courseName);
  const requestedCourseColor = getFirstParam(params.courseColor);
  const requestedDraftKey = getFirstParam(params.draft);
  const readingsParam = getFirstParam(params.readings);
  const requestedReadings = readingsParam ? readingsParam.split("|||") : undefined;
  const requestedEvidence = parseEvidence(getFirstParam(params.evidence));

  const activeConversation = userId && conversationId
    ? await db.tutorConversation.findFirst({
        where: {
          id: conversationId,
          userId,
        },
        select: {
          id: true,
          courseId: true,
          topicName: true,
          title: true,
          preview: true,
          readings: true,
          targetEvidence: true,
          createdAt: true,
          updatedAt: true,
          lastMessageAt: true,
          course: {
            select: {
              name: true,
              color: true,
            },
          },
          messages: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              role: true,
              content: true,
              responseId: true,
            },
          },
        },
      })
    : null;

  const scopeCourseId = activeConversation?.courseId ?? requestedCourseId;
  const scopeTopicName = activeConversation?.topicName ?? requestedTopicName;
  const summaryWhere =
    scopeCourseId || scopeTopicName
      ? {
          ...(scopeCourseId ? { courseId: scopeCourseId } : {}),
          ...(scopeTopicName ? { topicName: scopeTopicName } : {}),
        }
      : {};

  const conversationSummaries = userId
    ? (
        await db.tutorConversation.findMany({
          where: {
            userId,
            ...summaryWhere,
          },
          orderBy: [{ lastMessageAt: "desc" }],
          take: 12,
          select: {
            id: true,
            courseId: true,
            topicName: true,
            title: true,
            preview: true,
            readings: true,
            createdAt: true,
            updatedAt: true,
            lastMessageAt: true,
            course: {
              select: {
                name: true,
                color: true,
              },
            },
          },
        })
      ).map(buildTutorConversationSummary)
    : [];

  const conversationDetail = activeConversation
    ? buildTutorConversationDetail(activeConversation)
    : null;

  const courseId = activeConversation?.courseId ?? requestedCourseId;
  const courseName = activeConversation?.course?.name ?? requestedCourseName;
  const courseColor = activeConversation?.course?.color ?? requestedCourseColor;
  const topicName = activeConversation?.topicName ?? requestedTopicName;
  const readings =
    activeConversation && activeConversation.readings.length > 0
      ? activeConversation.readings
      : requestedReadings;
  const targetEvidence = conversationDetail?.targetEvidence ?? requestedEvidence;
  const initialMessages = conversationDetail?.messages ?? [];
  const draftKey =
    requestedDraftKey ??
    [courseId ?? "global", topicName ?? requestedPrompt ?? "blank"].join(":");

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TutorSession
        activeConversationId={conversationDetail?.id}
        conversationSummaries={conversationSummaries}
        courseId={courseId}
        courseName={courseName}
        courseColor={courseColor}
        draftKey={draftKey}
        forceAutoStart={!!requestedDraftKey && !conversationDetail}
        initialMessages={initialMessages}
        initialPrompt={conversationDetail ? undefined : requestedPrompt}
        readings={readings}
        targetEvidence={targetEvidence}
        topicName={topicName}
      />
    </div>
  );
}
