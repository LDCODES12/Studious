import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCalendarClient } from "@/lib/google";
import type { ExtractedClassSchedule, ClassMeeting } from "@/lib/parse-syllabus";

interface RouteParams {
  params: Promise<{ courseId: string }>;
}

/** Map RFC 5545 day code → JS Date.getDay() number (0=Sun). */
const DAY_CODE_TO_JS: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

/**
 * Given a semester start date and a list of RFC 5545 day codes,
 * returns the first calendar date >= start that falls on one of those days.
 */
function firstOccurrence(semesterStart: Date, days: string[]): Date {
  const jsDays = days.map((d) => DAY_CODE_TO_JS[d] ?? -1).filter((n) => n >= 0);
  const date = new Date(semesterStart);
  for (let i = 0; i < 14; i++) {
    if (jsDays.includes(date.getDay())) return date;
    date.setDate(date.getDate() + 1);
  }
  return semesterStart; // fallback
}

/**
 * Build an RFC 5545 RRULE for a weekly recurring event.
 * e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260508T235959Z"
 */
function buildRrule(days: string[], until: Date | null): string {
  const byday = days.join(",");
  if (until) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const y = until.getFullYear();
    const m = pad(until.getMonth() + 1);
    const d = pad(until.getDate());
    return `RRULE:FREQ=WEEKLY;BYDAY=${byday};UNTIL=${y}${m}${d}T235959Z`;
  }
  return `RRULE:FREQ=WEEKLY;BYDAY=${byday}`;
}

/**
 * Build the event start/end dateTimes from a date and HH:MM times.
 * Returns { dateTime: "YYYY-MM-DDTHH:MM:00", timeZone }.
 */
function buildDateTime(date: Date, time: string, timeZone: string) {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { dateTime: `${dateStr}T${pad(h)}:${pad(m)}:00`, timeZone };
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { courseId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check Google Calendar connection
  const tokensCookie = request.cookies.get("google_tokens");
  if (!tokensCookie) {
    return NextResponse.json({ error: "Google Calendar not connected" }, { status: 401 });
  }

  // Load course + schedule
  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
    select: { name: true, classSchedule: true },
  });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!course.classSchedule) {
    return NextResponse.json({ error: "No class schedule extracted yet" }, { status: 400 });
  }

  const schedule = course.classSchedule as unknown as ExtractedClassSchedule & {
    eventIds?: string[];
  };

  // Already synced — return existing event IDs
  if (schedule.eventIds && schedule.eventIds.length > 0) {
    return NextResponse.json({ ok: true, created: 0, eventIds: schedule.eventIds });
  }

  // Parse request body for client timezone
  let timeZone = "America/New_York";
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.timeZone === "string" && body.timeZone.length > 0) {
      timeZone = body.timeZone;
    }
  } catch { /* use default */ }

  const tokens = JSON.parse(tokensCookie.value);
  const calendar = getCalendarClient(tokens.access_token);

  const semStart = schedule.semesterStart ? new Date(schedule.semesterStart) : new Date();
  const semEnd = schedule.semesterEnd ? new Date(schedule.semesterEnd) : null;

  const eventIds: string[] = [];

  for (const meeting of schedule.meetings as ClassMeeting[]) {
    if (!meeting.days || meeting.days.length === 0) continue;
    if (!meeting.startTime || !meeting.endTime) continue;

    const firstDay = firstOccurrence(semStart, meeting.days);
    const rrule = buildRrule(meeting.days, semEnd);

    const startDt = buildDateTime(firstDay, meeting.startTime, timeZone);
    const endDt = buildDateTime(firstDay, meeting.endTime, timeZone);

    const summary = meeting.label
      ? `${course.name} — ${meeting.label}`
      : course.name;

    const resp = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        location: meeting.location || undefined,
        start: startDt,
        end: endDt,
        recurrence: [rrule],
      },
    });

    if (resp.data.id) eventIds.push(resp.data.id);
  }

  // Persist event IDs so duplicate clicks don't create new events
  if (eventIds.length > 0) {
    await db.course.update({
      where: { id: courseId },
      data: {
        classSchedule: { ...(schedule as object), eventIds } as object,
      },
    });
  }

  return NextResponse.json({ ok: true, created: eventIds.length, eventIds });
}

/** DELETE — remove all class schedule events from Google Calendar. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { courseId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tokensCookie = request.cookies.get("google_tokens");
  if (!tokensCookie) {
    return NextResponse.json({ error: "Google Calendar not connected" }, { status: 401 });
  }

  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
    select: { classSchedule: true },
  });
  if (!course?.classSchedule) return NextResponse.json({ ok: true, removed: 0 });

  const schedule = course.classSchedule as unknown as { eventIds?: string[] };
  const eventIds = schedule.eventIds ?? [];

  const tokens = JSON.parse(tokensCookie.value);
  const calendar = getCalendarClient(tokens.access_token);

  let removed = 0;
  for (const eventId of eventIds) {
    try {
      await calendar.events.delete({ calendarId: "primary", eventId });
      removed++;
    } catch { /* already deleted */ }
  }

  // Clear stored event IDs
  await db.course.update({
    where: { id: courseId },
    data: {
      classSchedule: { ...(schedule as object), eventIds: [] } as object,
    },
  });

  return NextResponse.json({ ok: true, removed });
}
