import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { generateObject } from "ai";
import { modelConfig } from "@/lib/ai-models";
import { z } from "zod";

const suggestionsSchema = z.object({
  suggestions: z.array(
    z.object({
      day: z.string(),
      time: z.string(),
      task: z.string(),
      reason: z.string(),
    })
  ),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { assignments, calendarEvents } = await request.json();

  try {
    const { object } = await generateObject({
      ...modelConfig("low"),
      schema: suggestionsSchema,
      system: `You are a study planner. Given a student's upcoming deadlines and existing calendar events, suggest 3-5 focused study sessions for the next 2 weeks.

Each suggestion must have:
- day: ISO date (YYYY-MM-DD)
- time: suggested time range (e.g. "2:00–4:00 PM")
- task: what to study/do (e.g. "Review lecture notes for Midterm 2", "Start Problem Set 3")
- reason: brief explanation of why this slot makes sense

Rules:
- Avoid scheduling on days that already have many calendar events
- Prioritize sessions 2-4 days before each deadline
- Keep sessions realistic (1-3 hours each)
- Today's date is ${new Date().toISOString().split("T")[0]}`,
      prompt: JSON.stringify({
        deadlines: (assignments as { title: string; dueDate: string; course?: { name: string } }[]).map(
          (a) => ({
            title: a.title,
            dueDate: a.dueDate,
            course: a.course?.name,
          })
        ),
        existingEvents: calendarEvents,
      }),
      abortSignal: AbortSignal.timeout(25_000),
    });

    return NextResponse.json({ suggestions: object.suggestions });
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}
