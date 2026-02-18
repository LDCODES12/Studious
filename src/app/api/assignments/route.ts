import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const assignments = await db.assignment.findMany({
    where: { course: { userId: session.user.id } },
    include: { course: { select: { id: true, name: true, shortName: true, color: true } } },
    orderBy: { dueDate: "asc" },
  });

  return NextResponse.json({ assignments });
}
