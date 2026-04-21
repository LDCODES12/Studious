import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

interface RouteParams {
  params: Promise<{ conversationId: string }>;
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { conversationId } = await params;

  const conversation = await db.tutorConversation.findFirst({
    where: {
      id: conversationId,
      userId: session.user.id,
    },
    select: { id: true },
  });

  if (!conversation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.tutorConversation.delete({
    where: { id: conversationId },
  });

  return NextResponse.json({ ok: true });
}
