import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseICS, inferType } from "@/lib/parse-ics";

const COLORS = ["blue", "green", "purple", "orange", "rose"];

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { canvasIcsUrl: true },
  });

  if (!user?.canvasIcsUrl) {
    return NextResponse.json({ error: "No Canvas ICS URL saved." }, { status: 400 });
  }

  // Fetch the ICS feed
  let icsText: string;
  try {
    const res = await fetch(user.canvasIcsUrl, {
      headers: { "User-Agent": "StudyCircle/1.0" },
      // 10-second timeout
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    icsText = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to fetch Canvas feed: ${msg}` },
      { status: 502 }
    );
  }

  const assignments = parseICS(icsText);
  if (assignments.length === 0) {
    return NextResponse.json({ ok: true, courses: [], assignmentCount: 0 });
  }

  // Group by course name
  const byCourse = new Map<string, typeof assignments>();
  for (const a of assignments) {
    if (!byCourse.has(a.courseName)) byCourse.set(a.courseName, []);
    byCourse.get(a.courseName)!.push(a);
  }

  // Get existing courses for color selection
  const existingCourses = await db.course.findMany({
    where: { userId: session.user.id },
    select: { id: true, name: true, color: true },
  });
  const usedColors = new Set(existingCourses.map((c) => c.color));
  const nextColor = () =>
    COLORS.find((c) => !usedColors.has(c)) ?? COLORS[existingCourses.length % COLORS.length];

  const savedCourses: { id: string; name: string; new: boolean }[] = [];
  let assignmentCount = 0;

  for (const [courseName, courseAssignments] of byCourse) {
    // Fuzzy match against existing courses
    const lc = courseName.toLowerCase();
    let course = existingCourses.find(
      (c) =>
        c.name.toLowerCase() === lc ||
        c.name.toLowerCase().includes(lc) ||
        lc.includes(c.name.toLowerCase())
    );

    const isNew = !course;
    if (!course) {
      const color = nextColor();
      usedColors.add(color);
      course = await db.course.create({
        data: {
          userId: session.user.id,
          name: courseName,
          shortName: courseName,
          color,
        },
      });
      existingCourses.push(course);
    }

    savedCourses.push({ id: course.id, name: course.name, new: isNew });

    // Upsert assignments by UID (Canvas UIDs are stable)
    for (const a of courseAssignments) {
      // Check for existing by UID stored in description, or by title+date
      const existing = await db.assignment.findFirst({
        where: {
          courseId: course.id,
          title: a.title,
          dueDate: a.dueDate,
        },
        select: { id: true },
      });

      if (existing) {
        // Already exists — skip (no overwrite of manually edited data)
        continue;
      }

      await db.assignment.create({
        data: {
          courseId: course.id,
          title: a.title,
          type: inferType(a.title),
          dueDate: a.dueDate,
          description: a.canvasUrl ? `Canvas: ${a.canvasUrl}` : null,
        },
      });
      assignmentCount++;
    }
  }

  return NextResponse.json({
    ok: true,
    courses: savedCourses,
    assignmentCount,
  });
}
