import { NextRequest, NextResponse } from "next/server";
import { getTokensFromCode } from "@/lib/google";

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

    response.cookies.set("google_tokens", JSON.stringify(tokens), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("Google OAuth error:", error);
    return NextResponse.redirect(
      new URL("/upload?error=auth_failed", request.url)
    );
  }
}
