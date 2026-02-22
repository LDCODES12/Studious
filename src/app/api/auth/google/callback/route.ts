import { NextRequest, NextResponse } from "next/server";
import { getTokensFromCode, GOOGLE_COOKIE_NAME, GOOGLE_COOKIE_OPTIONS } from "@/lib/google";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(new URL("/upload?error=no_code", request.url));
  }

  try {
    const tokens = await getTokensFromCode(code);

    const response = NextResponse.redirect(
      new URL("/upload?google=connected", request.url)
    );

    response.cookies.set(GOOGLE_COOKIE_NAME, JSON.stringify(tokens), GOOGLE_COOKIE_OPTIONS);

    return response;
  } catch (error) {
    console.error("Google OAuth error:", error);
    return NextResponse.redirect(
      new URL("/upload?error=auth_failed", request.url)
    );
  }
}
