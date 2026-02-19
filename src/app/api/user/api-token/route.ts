import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import crypto from "crypto";

function sha256(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** GET — returns whether a token is currently set */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { apiTokenHash: true },
  });

  return NextResponse.json({ hasToken: !!user?.apiTokenHash });
}

/** POST — generate a new token; returns raw token exactly once */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawToken = crypto.randomBytes(32).toString("hex"); // 64-char hex
  const hash = sha256(rawToken);

  await db.user.update({
    where: { id: session.user.id },
    data: { apiTokenHash: hash },
  });

  return NextResponse.json({ token: rawToken });
}

/** DELETE — revoke the current token */
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await db.user.update({
    where: { id: session.user.id },
    data: { apiTokenHash: null },
  });

  return NextResponse.json({ ok: true });
}
