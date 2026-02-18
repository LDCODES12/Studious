import { NextRequest, NextResponse } from "next/server";
import { getCalendarClient } from "@/lib/google";

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

    const { eventIds } = (await request.json()) as { eventIds: string[] };

    const results: { id: string; success: boolean }[] = [];

    for (const id of eventIds) {
      try {
        await calendar.events.delete({ calendarId: "primary", eventId: id });
        results.push({ id, success: true });
      } catch {
        results.push({ id, success: false });
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    console.error("Calendar remove error:", error);
    return NextResponse.json(
      { error: "Failed to remove events" },
      { status: 500 }
    );
  }
}
