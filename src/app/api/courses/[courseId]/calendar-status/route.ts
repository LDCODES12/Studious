import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCalendarClient } from "@/lib/google";

interface RouteParams {
  params: Promise<{ courseId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { courseId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
    include: {
      assignments: {
        where: { googleEventId: { not: null } },
        select: { id: true, googleEventId: true },
      },
    },
  });

  if (!course) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const tokensCookie = request.cookies.get("google_tokens");
  if (!tokensCookie || course.assignments.length === 0) {
    return NextResponse.json({ statuses: [] });
  }

  const tokens = JSON.parse(tokensCookie.value);
  const calendar = getCalendarClient(tokens.access_token);

  const results = await Promise.allSettled(
    course.assignments.map(async (a) => {
      try {
        await calendar.events.get({
          calendarId: "primary",
          eventId: a.googleEventId!,
        });
        return { assignmentId: a.id, exists: true };
      } catch {
        return { assignmentId: a.id, exists: false };
      }
    })
  );

  const statuses = results
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter(Boolean);

  return NextResponse.json({ statuses });
}
