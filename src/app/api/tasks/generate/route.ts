import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { generateTasksForUser } from "@/lib/tasks";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const created = await generateTasksForUser(session.user.id);

  return NextResponse.json({ ok: true, created });
}
