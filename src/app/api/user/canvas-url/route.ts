import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { canvasIcsUrl: true },
  });

  return NextResponse.json({ canvasIcsUrl: user?.canvasIcsUrl ?? null });
}

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { canvasIcsUrl } = (await request.json()) as { canvasIcsUrl: string | null };

  await db.user.update({
    where: { id: session.user.id },
    data: { canvasIcsUrl: canvasIcsUrl ?? null },
  });

  return NextResponse.json({ ok: true });
}
