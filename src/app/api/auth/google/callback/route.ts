import { NextRequest, NextResponse } from "next/server";
import { getTokensFromCode, GOOGLE_COOKIE_NAME, GOOGLE_COOKIE_OPTIONS } from "@/lib/google";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");

  if (!code) {
    return NextResponse.redirect(new URL("/upload?error=no_code", request.url));
  }

  let returnTo = "/upload";
  if (state) {
    try {
      const decoded = JSON.parse(Buffer.from(state, "base64url").toString());
      if (typeof decoded?.returnTo === "string" && decoded.returnTo.startsWith("/")) {
        returnTo = decoded.returnTo;
      }
    } catch { /* use default */ }
  }

  try {
    const tokens = await getTokensFromCode(code);

    const redirectUrl = returnTo === "/upload"
      ? new URL("/upload?google=connected", request.url)
      : new URL(`${returnTo}?google=connected`, request.url);

    const response = NextResponse.redirect(redirectUrl);
    response.cookies.set(GOOGLE_COOKIE_NAME, JSON.stringify(tokens), GOOGLE_COOKIE_OPTIONS);

    return response;
  } catch (error) {
    console.error("Google OAuth error:", error);
    return NextResponse.redirect(
      new URL("/upload?error=auth_failed", request.url)
    );
  }
}
