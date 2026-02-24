import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  getRefreshedCalendarClient,
  applyRefreshedTokensCookie,
  GOOGLE_COOKIE_NAME,
} from "@/lib/google";

interface RouteParams {
  params: Promise<{ assignmentId: string }>;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { assignmentId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const assignment = await db.assignment.findFirst({
    where: {
      id: assignmentId,
      course: { userId: session.user.id },
    },
    select: { id: true, googleEventId: true, title: true },
  });
  if (!assignment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const data: Record<string, unknown> = {};
  if (body.dueDate !== undefined) data.dueDate = body.dueDate;

  const updated = await db.assignment.update({
    where: { id: assignmentId },
    data,
    include: {
      course: {
        select: { id: true, name: true, shortName: true, color: true },
      },
    },
  });

  // Sync to Google Calendar if connected and event exists
  if (assignment.googleEventId && body.dueDate) {
    const tokensCookie = request.cookies.get(GOOGLE_COOKIE_NAME);
    if (tokensCookie) {
      try {
        const originalTokens = JSON.parse(tokensCookie.value);
        const { calendar, getUpdatedTokens } =
          getRefreshedCalendarClient(originalTokens);
        await calendar.events.patch({
          calendarId: "primary",
          eventId: assignment.googleEventId,
          requestBody: {
            start: { date: body.dueDate },
            end: { date: body.dueDate },
          },
        });
        const res = NextResponse.json({ assignment: updated });
        applyRefreshedTokensCookie(
          res,
          originalTokens,
          getUpdatedTokens()
        );
        return res;
      } catch {
        // Non-fatal: assignment was updated, calendar sync failed
      }
    }
  }

  return NextResponse.json({ assignment: updated });
}
