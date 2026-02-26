import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRefreshedCalendarClient, applyRefreshedTokensCookie } from "@/lib/google";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const tokensCookie = request.cookies.get("google_tokens");
    if (!tokensCookie) {
      return NextResponse.json(
        { error: "Not connected to Google Calendar" },
        { status: 401 }
      );
    }

    const tokens = JSON.parse(tokensCookie.value);
    const { calendar, getUpdatedTokens } = getRefreshedCalendarClient(tokens);

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

    const res = NextResponse.json({ results });
    applyRefreshedTokensCookie(res, tokens, getUpdatedTokens());
    return res;
  } catch (error) {
    console.error("Calendar remove error:", error);
    return NextResponse.json(
      { error: "Failed to remove events" },
      { status: 500 }
    );
  }
}
