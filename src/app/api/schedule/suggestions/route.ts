import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { assignments, calendarEvents } = await request.json();

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a study planner. Given a student's upcoming deadlines and existing calendar events, suggest 3-5 focused study sessions for the next 2 weeks.

Return JSON with a "suggestions" array. Each suggestion must have:
- day: ISO date (YYYY-MM-DD)
- time: suggested time range (e.g. "2:00–4:00 PM")
- task: what to study/do (e.g. "Review lecture notes for Midterm 2", "Start Problem Set 3")
- reason: brief explanation of why this slot makes sense

Rules:
- Avoid scheduling on days that already have many calendar events
- Prioritize sessions 2-4 days before each deadline
- Keep sessions realistic (1-3 hours each)
- Today's date is ${new Date().toISOString().split("T")[0]}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            deadlines: (assignments as { title: string; dueDate: string; course?: { name: string } }[]).map(
              (a) => ({
                title: a.title,
                dueDate: a.dueDate,
                course: a.course?.name,
              })
            ),
            existingEvents: calendarEvents,
          }),
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return NextResponse.json({ suggestions: [] });

    const parsed = JSON.parse(content);
    return NextResponse.json({ suggestions: parsed.suggestions ?? [] });
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}
