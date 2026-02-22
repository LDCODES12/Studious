import { google } from "googleapis";
import type { Credentials } from "google-auth-library";
import type { NextResponse } from "next/server";

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

export const GOOGLE_COOKIE_NAME = "google_tokens";
export const GOOGLE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 24 * 30,
  path: "/",
};

export function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.NEXTAUTH_URL ?? "http://localhost:3000"}/api/auth/google/callback`
  );
}

export function getAuthUrl() {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
}

export async function getTokensFromCode(code: string) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

/**
 * Returns a calendar client with full token credentials so googleapis can
 * auto-refresh the access_token when it expires.
 *
 * After making Google Calendar API calls, check `getUpdatedTokens()`.
 * If non-null, call `applyRefreshedTokensCookie(response, originalTokens, updated)`
 * to write the new access_token back to the cookie so future requests work.
 */
export function getRefreshedCalendarClient(rawTokens: Record<string, unknown>) {
  const client = getOAuth2Client();
  client.setCredentials(rawTokens as Credentials);

  let updatedTokens: Credentials | null = null;
  // googleapis emits this event whenever it automatically issues a new access_token
  client.on("tokens", (tokens) => {
    updatedTokens = tokens;
  });

  const calendar = google.calendar({ version: "v3", auth: client });
  return {
    calendar,
    /** Returns newly-issued credentials if googleapis auto-refreshed; otherwise null. */
    getUpdatedTokens: () => updatedTokens,
  };
}

/**
 * If googleapis issued a refreshed access_token during the request, merge it
 * into the stored cookie so future requests don't need to re-authorize.
 */
export function applyRefreshedTokensCookie(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: NextResponse<any>,
  originalTokens: Record<string, unknown>,
  updatedTokens: Credentials | null
) {
  if (!updatedTokens) return;
  const merged = { ...originalTokens, ...updatedTokens };
  response.cookies.set(GOOGLE_COOKIE_NAME, JSON.stringify(merged), GOOGLE_COOKIE_OPTIONS);
}
