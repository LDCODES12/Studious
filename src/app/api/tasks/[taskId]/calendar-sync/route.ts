import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCalendarClient } from "@/lib/google";

interface RouteParams {
  params: Promise<{ taskId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { taskId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const task = await db.task.findFirst({
    where: { id: taskId, userId: session.user.id },
    include: { course: { select: { name: true } } },
  });

  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!task.dueDate) {
    return NextResponse.json({ error: "Task has no due date" }, { status: 400 });
  }

  const tokensCookie = request.cookies.get("google_tokens");
  if (!tokensCookie) {
    return NextResponse.json({ error: "Google Calendar not connected" }, { status: 401 });
  }

  const tokens = JSON.parse(tokensCookie.value);
  const calendar = getCalendarClient(tokens.access_token);

  // Build event — use time if available, otherwise all-day
  const summary = task.course ? `${task.title} — ${task.course.name}` : task.title;
  let start: Record<string, string>;
  let end: Record<string, string>;

  if (task.dueTime) {
    // Timed event: 1-hour block at the specified time
    const startHour = parseInt(task.dueTime.split(":")[0], 10);
    const endHour = String(startHour + 1).padStart(2, "0");
    const endMin = task.dueTime.split(":")[1];
    start = { dateTime: `${task.dueDate}T${task.dueTime}:00`, timeZone: "America/New_York" };
    end = { dateTime: `${task.dueDate}T${endHour}:${endMin}:00`, timeZone: "America/New_York" };
  } else if (task.source === "auto" && (task.sourceType === "study" || task.sourceType === "review")) {
    // Auto study/review tasks: 2-hour evening block
    start = { dateTime: `${task.dueDate}T18:00:00`, timeZone: "America/New_York" };
    end = { dateTime: `${task.dueDate}T20:00:00`, timeZone: "America/New_York" };
  } else {
    // All-day event
    start = { date: task.dueDate };
    end = { date: task.dueDate };
  }

  const response = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary,
      description: task.description || undefined,
      start,
      end,
    },
  });

  const googleEventId = response.data.id!;

  await db.task.update({
    where: { id: taskId },
    data: { googleEventId },
  });

  return NextResponse.json({ ok: true, googleEventId });
}
