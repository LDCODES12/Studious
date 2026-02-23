import { NextRequest, NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Receives client-side logs from the Chrome extension and emits them as
 * structured JSON to stdout so they appear in Vercel's log viewer.
 * No auth required — the payload is just log data, no mutations.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const entries: unknown[] = Array.isArray(body) ? body : [body];

    // Single log line with the full array — avoids Vercel truncation issues
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), source: "extension", count: entries.length, entries }),
    );

    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400, headers: CORS_HEADERS });
  }
}
