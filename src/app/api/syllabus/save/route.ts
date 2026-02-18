import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { type SyllabusEvent } from "@/types";

const COLORS = ["blue", "green", "purple", "orange", "rose"];

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { events, syncResults } = (await request.json()) as {
    events: SyllabusEvent[];
    syncResults: { title: string; success: boolean; googleEventId?: string | null }[];
  };

  if (!events || events.length === 0) {
    return NextResponse.json({ error: "No events provided" }, { status: 400 });
  }

  // Build a map of title → googleEventId from sync results
  const googleIdMap = new Map<string, string>();
  for (const r of syncResults ?? []) {
    if (r.success && r.googleEventId) {
      googleIdMap.set(r.title, r.googleEventId);
    }
  }

  // Group events by course name
  const byCourse = new Map<string, SyllabusEvent[]>();
  for (const event of events) {
    const key = event.courseName;
    if (!byCourse.has(key)) byCourse.set(key, []);
    byCourse.get(key)!.push(event);
  }

  // Get existing courses for this user to pick a color that's not used yet
  const existingCourses = await db.course.findMany({
    where: { userId: session.user.id },
    select: { color: true },
  });
  const usedColors = new Set(existingCourses.map((c) => c.color));
  const nextColor = () => COLORS.find((c) => !usedColors.has(c)) ?? COLORS[existingCourses.length % COLORS.length];

  for (const [courseName, courseEvents] of byCourse) {
    // Find or create the course
    let course = await db.course.findFirst({
      where: { userId: session.user.id, name: courseName },
    });

    if (!course) {
      const color = nextColor();
      usedColors.add(color);
      course = await db.course.create({
        data: {
          userId: session.user.id,
          name: courseName,
          shortName: courseEvents[0]?.courseName ?? courseName,
          color,
        },
      });
    }

    // Upsert assignments (avoid duplicates on re-upload)
    for (const event of courseEvents) {
      await db.assignment.upsert({
        where: {
          // Use a composite-ish approach: find by title+dueDate+courseId
          id: (
            await db.assignment.findFirst({
              where: { courseId: course.id, title: event.title, dueDate: event.dueDate },
              select: { id: true },
            })
          )?.id ?? "new",
        },
        update: {
          googleEventId: googleIdMap.get(event.title) ?? undefined,
        },
        create: {
          courseId: course.id,
          title: event.title,
          type: event.type,
          dueDate: event.dueDate,
          description: event.description ?? null,
          googleEventId: googleIdMap.get(event.title) ?? null,
        },
      });
    }
  }

  return NextResponse.json({ ok: true });
}
