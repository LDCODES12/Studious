import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const courses = await db.course.findMany({
    where: { userId: session.user.id },
    include: { assignments: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ courses });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { name, shortName, instructor, term, color, schedule, location } = body;

  if (!name) {
    return NextResponse.json({ error: "Course name is required" }, { status: 400 });
  }

  const course = await db.course.create({
    data: {
      userId: session.user.id,
      name,
      shortName: shortName || null,
      instructor: instructor || null,
      term: term || null,
      color: color || "blue",
      schedule: schedule || null,
      location: location || null,
    },
  });

  return NextResponse.json({ course }, { status: 201 });
}
