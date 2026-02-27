import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ processing: false });
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { bgSyncProcessingAt: true },
  });

  // Stale guard: treat timestamps older than 10 minutes as not processing
  // (in case after() crashed without clearing the flag)
  const isProcessing =
    !!user?.bgSyncProcessingAt &&
    Date.now() - new Date(user.bgSyncProcessingAt).getTime() < 10 * 60 * 1000;

  return NextResponse.json({ processing: isProcessing });
}
