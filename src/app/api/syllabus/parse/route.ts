import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { parseSyllabusText, parseSyllabusTopics } from "@/lib/parse-syllabus";
import { apiLogger } from "@/lib/logger";
import { type SyllabusEvent } from "@/types";

type TopicRow = {
  weekNumber: number;
  weekLabel: string;
  startDate: string | null;
  topics: string[];
  readings: string[];
  notes: string | null;
};

type ParsedDocumentInput = {
  fileName?: string | null;
  text: string;
};

type ParsedCourseDocument = {
  fileName: string;
  text: string;
};

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const log = apiLogger("POST /api/syllabus/parse", session.user.id);

  try {
    const payload = (await request.json()) as {
      texts?: string[];
      documents?: ParsedDocumentInput[];
    };
    const documents = (payload.documents ?? payload.texts?.map((text, index) => ({
      fileName: `Uploaded syllabus ${index + 1}.pdf`,
      text,
    })) ?? [])
      .map((document, index) => ({
        fileName: document.fileName?.trim() || `Uploaded syllabus ${index + 1}.pdf`,
        text: document.text,
      }))
      .filter((document) => document.text.trim());

    if (documents.length === 0) {
      return log.respond(NextResponse.json({ error: "No text provided" }, { status: 400 }));
    }

    log.info("parsing syllabus", { textCount: documents.length });

    const allEvents: SyllabusEvent[] = [];
    const topicsByCourse: Record<string, TopicRow[]> = {};
    const documentsByCourse: Record<string, ParsedCourseDocument[]> = {};

    await Promise.all(
      documents.map(async (document) => {
        const text = document.text.trim();
        const [events, topics] = await Promise.all([
          parseSyllabusText(text),
          parseSyllabusTopics(text),
        ]);

        for (const event of events) {
          allEvents.push({
            id: crypto.randomUUID(),
            title: event.title,
            type: event.type,
            dueDate: event.dueDate,
            courseName: event.courseName,
            description: event.description,
            selected: true,
          });
        }

        const courseKey = events[0]?.courseName ?? topics[0]?.courseName;
        if (!courseKey) return;

        documentsByCourse[courseKey] = [
          ...(documentsByCourse[courseKey] ?? []),
          {
            fileName: document.fileName,
            text,
          },
        ];

        if (topics.length > 0) {
          topicsByCourse[courseKey] = topics.map(
            ({ courseName, ...rest }) => {
              void courseName;
              return rest;
            },
          );
        }
      }),
    );

    return log.respond(
      NextResponse.json({ events: allEvents, topicsByCourse, documentsByCourse }),
      {
        events: allEvents.length,
        topicCourses: Object.keys(topicsByCourse).length,
        documentCourses: Object.keys(documentsByCourse).length,
      },
    );
  } catch (error) {
    log.error("syllabus parse failed", { error: error instanceof Error ? error.message : String(error) });
    return log.respond(NextResponse.json(
      { error: "Failed to parse syllabus" },
      { status: 500 }
    ));
  }
}
