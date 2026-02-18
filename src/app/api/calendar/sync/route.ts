import { NextRequest, NextResponse } from "next/server";
import { getCalendarClient } from "@/lib/google";
import { type SyllabusEvent } from "@/types";

export async function POST(request: NextRequest) {
  try {
    const tokensCookie = request.cookies.get("google_tokens");
    if (!tokensCookie) {
      return NextResponse.json(
        { error: "Not connected to Google Calendar" },
        { status: 401 }
      );
    }

    const tokens = JSON.parse(tokensCookie.value);
    const calendar = getCalendarClient(tokens.access_token);

    const { events } = (await request.json()) as { events: SyllabusEvent[] };

    const results: { title: string; success: boolean; googleEventId?: string | null; error?: string }[] = [];

    for (const event of events) {
      try {
        const response = await calendar.events.insert({
          calendarId: "primary",
          requestBody: {
            summary: event.title,
            description: `${event.courseName} — ${event.type}${event.description ? `\n${event.description}` : ""}`,
            start: { date: event.dueDate },
            end: { date: event.dueDate },
          },
        });
        results.push({ title: event.title, success: true, googleEventId: response.data.id ?? null });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        results.push({ title: event.title, success: false, error: message });
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    console.error("Calendar sync error:", error);
    return NextResponse.json(
      { error: "Failed to sync to calendar" },
      { status: 500 }
    );
  }
}
