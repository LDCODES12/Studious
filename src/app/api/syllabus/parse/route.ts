import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { parseSyllabusText, parseSyllabusTopics } from "@/lib/parse-syllabus";
import { apiLogger } from "@/lib/logger";
import { type SyllabusEvent } from "@/types";

type TopicRow = {
  weekNumber: number;
  weekLabel: string;
  startDate?: string;
  topics: string[];
  readings: string[];
  notes?: string;
};

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const log = apiLogger("POST /api/syllabus/parse", session.user.id);

  try {
    const { texts } = (await request.json()) as { texts: string[] };

    if (!texts || texts.length === 0) {
      return log.respond(NextResponse.json({ error: "No text provided" }, { status: 400 }));
    }

    log.info("parsing syllabus", { textCount: texts.length });

    const allEvents: SyllabusEvent[] = [];
    const topicsByCourse: Record<string, TopicRow[]> = {};

    await Promise.all(
      texts
        .filter((t) => t.trim())
        .map(async (text) => {
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

          if (topics.length > 0) {
            // Key by the event courseName (same source the save route uses) to
            // guarantee the lookup matches. Fall back to what the AI returned.
            const courseKey = events[0]?.courseName ?? topics[0]?.courseName;
            if (courseKey) {
              topicsByCourse[courseKey] = topics.map(
                ({ courseName: _cn, ...rest }) => rest
              );
            }
          }
        })
    );

    return log.respond(
      NextResponse.json({ events: allEvents, topicsByCourse }),
      { events: allEvents.length, topicCourses: Object.keys(topicsByCourse).length },
    );
  } catch (error) {
    log.error("syllabus parse failed", { error: error instanceof Error ? error.message : String(error) });
    return log.respond(NextResponse.json(
      { error: "Failed to parse syllabus" },
      { status: 500 }
    ));
  }
}
