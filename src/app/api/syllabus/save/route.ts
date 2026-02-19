import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { type SyllabusEvent } from "@/types";

const COLORS = ["blue", "green", "purple", "orange", "rose"];

type TopicData = {
  weekNumber: number;
  weekLabel: string;
  startDate?: string;
  topics: string[];
  readings: string[];
  notes?: string;
};

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { events, syncResults, topicsByCourse } = (await request.json()) as {
    events: SyllabusEvent[];
    syncResults: { title: string; success: boolean; googleEventId?: string | null }[];
    topicsByCourse?: Record<string, TopicData[]>;
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
  const nextColor = () =>
    COLORS.find((c) => !usedColors.has(c)) ?? COLORS[existingCourses.length % COLORS.length];

  const savedCourses: { id: string; name: string }[] = [];

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

    savedCourses.push({ id: course.id, name: course.name });

    // Upsert assignments (avoid duplicates on re-upload)
    for (const event of courseEvents) {
      await db.assignment.upsert({
        where: {
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

    // Save weekly topics — try exact match first, then fuzzy
    const lc = courseName.toLowerCase();
    const courseTopics =
      topicsByCourse?.[courseName] ??
      Object.entries(topicsByCourse ?? {}).find(
        ([k]) =>
          k.toLowerCase() === lc ||
          k.toLowerCase().includes(lc) ||
          lc.includes(k.toLowerCase())
      )?.[1];
    if (courseTopics && courseTopics.length > 0) {
      await db.courseTopic.deleteMany({ where: { courseId: course.id } });
      await db.courseTopic.createMany({
        data: courseTopics.map((t) => ({
          courseId: course.id,
          weekNumber: t.weekNumber,
          weekLabel: t.weekLabel,
          startDate: t.startDate ?? null,
          topics: t.topics,
          readings: t.readings,
          notes: t.notes ?? null,
        })),
      });
    }
  }

  return NextResponse.json({ ok: true, courses: savedCourses });
}
