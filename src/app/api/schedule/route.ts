import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getRefreshedCalendarClient, applyRefreshedTokensCookie } from "@/lib/google";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const today = new Date();
  const defaultStart = today.toISOString().split("T")[0];
  const defaultEnd = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const start = searchParams.get("start") ?? defaultStart;
  const end = searchParams.get("end") ?? defaultEnd;

  // Fetch assignments within the date range
  const assignments = await db.assignment.findMany({
    where: {
      course: { userId: session.user.id },
      dueDate: { gte: start, lte: end },
    },
    include: {
      course: { select: { id: true, name: true, shortName: true, color: true } },
    },
    orderBy: { dueDate: "asc" },
  });

  // Fetch GCal events if connected
  let calendarEvents: { id: string; summary: string; start: string; end: string }[] = [];
  const tokensCookie = request.cookies.get("google_tokens");
  let updatedGoogleTokens = null;
  let originalTokens: Record<string, unknown> = {};
  if (tokensCookie) {
    try {
      originalTokens = JSON.parse(tokensCookie.value);
      const { calendar, getUpdatedTokens } = getRefreshedCalendarClient(originalTokens);
      const gcalRes = await calendar.events.list({
        calendarId: "primary",
        timeMin: new Date(start).toISOString(),
        timeMax: new Date(`${end}T23:59:59`).toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 100,
      });
      calendarEvents = (gcalRes.data.items ?? []).map((e) => ({
        id: e.id ?? "",
        summary: e.summary ?? "(No title)",
        start: e.start?.date ?? e.start?.dateTime ?? "",
        end: e.end?.date ?? e.end?.dateTime ?? "",
      }));
      updatedGoogleTokens = getUpdatedTokens();
    } catch {
      // Silently ignore GCal errors
    }
  }

  const res = NextResponse.json({
    assignments: assignments.map((a) => ({
      id: a.id,
      title: a.title,
      type: a.type,
      dueDate: a.dueDate,
      status: a.status,
      course: a.course,
    })),
    calendarEvents,
  });
  applyRefreshedTokensCookie(res, originalTokens, updatedGoogleTokens);
  return res;
}
