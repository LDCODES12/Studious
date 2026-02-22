import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getRefreshedCalendarClient, applyRefreshedTokensCookie } from "@/lib/google";

interface RouteParams {
  params: Promise<{ assignmentId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { assignmentId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const assignment = await db.assignment.findFirst({
    where: { id: assignmentId },
    include: { course: true },
  });

  if (!assignment || assignment.course.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!assignment.dueDate) {
    return NextResponse.json({ error: "Assignment has no due date" }, { status: 400 });
  }

  const tokensCookie = request.cookies.get("google_tokens");
  if (!tokensCookie) {
    return NextResponse.json({ error: "Google Calendar not connected" }, { status: 401 });
  }

  const tokens = JSON.parse(tokensCookie.value);
  const { calendar, getUpdatedTokens } = getRefreshedCalendarClient(tokens);

  const response = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: assignment.title,
      description: `${assignment.course.name} — ${assignment.type}${
        assignment.description ? `\n${assignment.description}` : ""
      }`,
      start: { date: assignment.dueDate },
      end: { date: assignment.dueDate },
    },
  });

  const googleEventId = response.data.id!;

  await db.assignment.update({
    where: { id: assignmentId },
    data: { googleEventId },
  });

  const res = NextResponse.json({ googleEventId });
  applyRefreshedTokensCookie(res, tokens, getUpdatedTokens());
  return res;
}
