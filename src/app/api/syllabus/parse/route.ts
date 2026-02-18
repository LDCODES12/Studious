import { NextRequest, NextResponse } from "next/server";
import { parseSyllabusText } from "@/lib/parse-syllabus";
import { type SyllabusEvent } from "@/types";

export async function POST(request: NextRequest) {
  try {
    const { texts } = (await request.json()) as { texts: string[] };

    if (!texts || texts.length === 0) {
      return NextResponse.json({ error: "No text provided" }, { status: 400 });
    }

    const allEvents: SyllabusEvent[] = [];

    for (const text of texts) {
      if (!text.trim()) continue;

      const parsed = await parseSyllabusText(text);

      for (const event of parsed) {
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
    }

    return NextResponse.json({ events: allEvents });
  } catch (error) {
    console.error("Syllabus parse error:", error);
    return NextResponse.json(
      { error: "Failed to parse syllabus" },
      { status: 500 }
    );
  }
}
