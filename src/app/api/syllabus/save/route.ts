import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { ingestStandaloneEvidence, rebuildCourseCorpusProjections } from "@/lib/course-corpus/sync";
import { type SyllabusEvent } from "@/types";

const COLORS = ["blue", "green", "purple", "orange", "rose"];

type TopicData = {
  weekNumber: number;
  weekLabel: string;
  startDate: string | null;
  topics: string[];
  readings: string[];
  notes: string | null;
};

type ParsedCourseDocument = {
  fileName: string;
  text: string;
};

function matchCoursePayload<T>(payload: Record<string, T> | undefined, courseName: string): T | undefined {
  if (!payload) return undefined;
  if (payload[courseName] !== undefined) return payload[courseName];

  const lc = courseName.toLowerCase();
  return Object.entries(payload).find(
    ([key]) =>
      key.toLowerCase() === lc ||
      key.toLowerCase().includes(lc) ||
      lc.includes(key.toLowerCase()),
  )?.[1];
}

function buildTopicFallbackDocument(courseName: string, courseTopics: TopicData[]): string {
  return [
    `${courseName} parsed syllabus outline`,
    ...courseTopics.map((topic) => {
      const lines = [
        topic.weekLabel || `Week ${topic.weekNumber}`,
        topic.startDate ? `Start date: ${topic.startDate}` : null,
        topic.topics.length > 0 ? `Topics: ${topic.topics.join("; ")}` : null,
        topic.readings.length > 0 ? `Readings: ${topic.readings.join("; ")}` : null,
        topic.notes ? `Notes: ${topic.notes}` : null,
      ].filter(Boolean);
      return lines.join("\n");
    }),
  ].join("\n\n");
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { events, syncResults, topicsByCourse, documentsByCourse } = (await request.json()) as {
    events: SyllabusEvent[];
    syncResults: { title: string; success: boolean; googleEventId?: string | null }[];
    topicsByCourse?: Record<string, TopicData[]>;
    documentsByCourse?: Record<string, ParsedCourseDocument[]>;
  };

  if (!events || events.length === 0) {
    return NextResponse.json({ error: "No events provided" }, { status: 400 });
  }

  // Build a map of title → googleEventId from sync results
  const googleIdMap = new Map<string, string>();
  for (const r of syncResults ?? []) {
    if (r.success && r.googleEventId) {
      googleIdMap.set(r.title, r.googleEventId);
    }
  }

  // Group events by course name
  const byCourse = new Map<string, SyllabusEvent[]>();
  for (const event of events) {
    const key = event.courseName;
    if (!byCourse.has(key)) byCourse.set(key, []);
    byCourse.get(key)!.push(event);
  }

  // Get existing courses for this user to pick a color that's not used yet
  const existingCourses = await db.course.findMany({
    where: { userId: session.user.id },
    select: { color: true },
  });
  const usedColors = new Set(existingCourses.map((c) => c.color));
  const nextColor = () =>
    COLORS.find((c) => !usedColors.has(c)) ?? COLORS[existingCourses.length % COLORS.length];

  const savedCourses: { id: string; name: string }[] = [];

  for (const [courseName, courseEvents] of byCourse) {
    // Find or create the course
    let course = await db.course.findFirst({
      where: { userId: session.user.id, name: courseName },
    });

    if (!course) {
      const color = nextColor();
      usedColors.add(color);
      course = await db.course.create({
        data: {
          userId: session.user.id,
          name: courseName,
          shortName: courseEvents[0]?.courseName ?? courseName,
          color,
        },
      });
    }

    savedCourses.push({ id: course.id, name: course.name });

    // Upsert assignments (avoid duplicates on re-upload)
    for (const event of courseEvents) {
      await db.assignment.upsert({
        where: {
          id: (
            await db.assignment.findFirst({
              where: { courseId: course.id, title: event.title, dueDate: event.dueDate },
              select: { id: true },
            })
          )?.id ?? "new",
        },
        update: {
          googleEventId: googleIdMap.get(event.title) ?? undefined,
        },
        create: {
          courseId: course.id,
          title: event.title,
          type: event.type,
          dueDate: event.dueDate,
          description: event.description ?? null,
          googleEventId: googleIdMap.get(event.title) ?? null,
        },
      });
    }

    const courseTopics = matchCoursePayload(topicsByCourse, courseName) ?? [];
    const courseDocuments = matchCoursePayload(documentsByCourse, courseName) ?? [];

    if (courseDocuments.length > 0) {
      for (const [index, document] of courseDocuments.entries()) {
        await ingestStandaloneEvidence({
          courseId: course.id,
          rawSourceKind: "manual_upload",
          sourceKey: `manual-syllabus:${index}:${document.fileName.toLowerCase()}`,
          title: document.fileName,
          text: document.text,
        });
      }
    } else if (courseTopics.length > 0) {
      await ingestStandaloneEvidence({
        courseId: course.id,
        rawSourceKind: "manual_upload",
        sourceKey: `manual-syllabus-outline:${courseName.toLowerCase()}`,
        title: `${courseName} parsed syllabus outline`,
        text: buildTopicFallbackDocument(courseName, courseTopics),
      });
    }

    if (courseDocuments.length > 0 || courseTopics.length > 0) {
      await rebuildCourseCorpusProjections({
        courseId: course.id,
        courseName: course.name,
      });
    }
  }

  return NextResponse.json({ ok: true, courses: savedCourses });
}
