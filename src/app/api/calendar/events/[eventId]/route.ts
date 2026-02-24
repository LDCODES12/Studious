import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  getRefreshedCalendarClient,
  applyRefreshedTokensCookie,
  GOOGLE_COOKIE_NAME,
} from "@/lib/google";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { eventId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tokensCookie = request.cookies.get(GOOGLE_COOKIE_NAME);
  if (!tokensCookie) {
    return NextResponse.json(
      { error: "Google Calendar not connected" },
      { status: 400 }
    );
  }

  const body = await request.json();
  const { start, end } = body as { start?: string; end?: string };
  if (!start && !end) {
    return NextResponse.json(
      { error: "Provide start and/or end" },
      { status: 400 }
    );
  }

  const originalTokens = JSON.parse(tokensCookie.value);
  const { calendar, getUpdatedTokens } =
    getRefreshedCalendarClient(originalTokens);

  const patch: Record<string, unknown> = {};
  if (start) {
    patch.start = start.length === 10
      ? { date: start }
      : { dateTime: start, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  if (end) {
    patch.end = end.length === 10
      ? { date: end }
      : { dateTime: end, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }

  try {
    await calendar.events.patch({
      calendarId: "primary",
      eventId,
      requestBody: patch,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to update event", detail: msg },
      { status: 502 }
    );
  }

  const res = NextResponse.json({ ok: true });
  applyRefreshedTokensCookie(res, originalTokens, getUpdatedTokens());
  return res;
}
