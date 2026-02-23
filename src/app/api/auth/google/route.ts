import { NextRequest, NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/google";

export async function GET(request: NextRequest) {
  const returnTo = request.nextUrl.searchParams.get("returnTo") ?? undefined;
  const url = getAuthUrl(returnTo);
  return NextResponse.redirect(url);
}
