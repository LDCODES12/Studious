import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { db } from "@/lib/db";
import { getRefreshedCalendarClient } from "@/lib/google";
import { addDays } from "date-fns";
import { runStudyPlanPipeline } from "@/lib/study-plan-engine";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const log = apiLogger("POST /api/study-plan", session.user.id);

  const body = await request.json().catch(() => ({}));
  const mode: "day" | "week" = body.mode === "week" ? "week" : "day";
  const days = mode === "day" ? 1 : 7;

  log.info("study plan request", { mode });

  // Log plan generation event (fire-and-forget)
  db.learningEvent.create({
    data: {
      userId: session.user.id,
      type: "plan_generated",
      metadata: { mode },
    },
  }).catch(() => {});

  // Fetch calendar events for the pipeline
  const now = new Date();
  const rangeEnd = addDays(now, days);
  let calendarEvents: { summary: string; start: string; end: string }[] = [];

  const tokensCookie = request.cookies.get("google_tokens");
  if (tokensCookie) {
    try {
      const tokens = JSON.parse(tokensCookie.value);
      const { calendar } = getRefreshedCalendarClient(tokens);
      const gcalRes = await calendar.events.list({
        calendarId: "primary",
        timeMin: now.toISOString(),
        timeMax: rangeEnd.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 100,
      });
      calendarEvents = (gcalRes.data.items ?? [])
        .filter((e) => e.start?.dateTime && e.end?.dateTime)
        .map((e) => ({
          summary: e.summary ?? "(busy)",
          start: e.start!.dateTime!,
          end: e.end!.dateTime!,
        }));
    } catch { /* GCal fetch failure is non-fatal */ }
  }

  // Run the multi-stage pipeline
  const result = await runStudyPlanPipeline(session.user.id, mode, now, calendarEvents);

  log.info("study plan generated", {
    mode,
    sessions: result.summary.sessionCount,
    studyHours: result.summary.studyHours,
  });

  return Response.json(result);
}
