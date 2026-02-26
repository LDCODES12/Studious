import { NextRequest } from "next/server";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { buildStudyContext } from "@/lib/course-context";
import { db } from "@/lib/db";
import { getRefreshedCalendarClient } from "@/lib/google";
import { format, addDays } from "date-fns";
import type { ExtractedClassSchedule, ClassMeeting } from "@/lib/parse-syllabus";

export const maxDuration = 60;

const DAY_CODE_TO_JS: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
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

  // 1. Build academic context
  const { promptText } = await buildStudyContext(session.user.id);

  // 2. Fetch calendar events for the timeframe
  const now = new Date();
  const rangeEnd = addDays(now, days);
  let calendarBusyBlocks = "";

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
      const events = (gcalRes.data.items ?? [])
        .filter((e) => e.start?.dateTime && e.end?.dateTime)
        .map((e) => ({
          summary: e.summary ?? "(busy)",
          start: e.start!.dateTime!,
          end: e.end!.dateTime!,
        }));
      if (events.length > 0) {
        calendarBusyBlocks =
          "\n\nCalendar events (busy — do NOT schedule over these):\n" +
          events
            .map((e) => `- ${e.summary}: ${format(new Date(e.start), "EEE h:mm a")} – ${format(new Date(e.end), "h:mm a")}`)
            .join("\n");
      }
    } catch { /* GCal fetch failure is non-fatal */ }
  }

  // 3. Expand class schedule meetings into concrete busy blocks
  const courses = await db.course.findMany({
    where: { userId: session.user.id },
    select: { name: true, classSchedule: true },
  });

  let classBusyBlocks = "";
  const classBlocks: string[] = [];

  for (const course of courses) {
    const sched = course.classSchedule as ExtractedClassSchedule | null;
    if (!sched?.meetings) continue;

    for (const meeting of sched.meetings as ClassMeeting[]) {
      if (!meeting.days?.length || !meeting.startTime || !meeting.endTime) continue;

      const jsDays = meeting.days.map((d) => DAY_CODE_TO_JS[d]).filter((n) => n != null);

      for (let offset = 0; offset <= days; offset++) {
        const day = addDays(now, offset);
        if (jsDays.includes(day.getDay())) {
          const label = meeting.label ? `${course.name} (${meeting.label})` : course.name;
          classBlocks.push(`- ${label}: ${format(day, "EEE")} ${meeting.startTime} – ${meeting.endTime}`);
        }
      }
    }
  }

  if (classBlocks.length > 0) {
    classBusyBlocks = "\n\nClass meetings (busy — do NOT schedule over these):\n" + classBlocks.join("\n");
  }

  // 4. Build system prompt
  const today = format(now, "EEEE, MMMM d, yyyy h:mm a");
  const planScope = mode === "day" ? "today" : "this week (next 7 days)";

  const system = `You are a study planning assistant. Build a concrete, realistic study plan for ${planScope}.

Today is ${today}.

ACADEMIC CONTEXT:
${promptText}${calendarBusyBlocks}${classBusyBlocks}

PLANNING RULES:
- Create specific study sessions with: time range, course name, concrete task, and brief rationale
- No sessions before 8:00 AM or after 11:00 PM
- Sessions should be 1–3 hours each
- Leave 30-minute buffer around class meetings
- Prioritize by: (1) urgency — what's due soonest, (2) grade impact — higher point values first, (3) difficulty — harder tasks need earlier, longer sessions
- Spread exam review across multiple days — don't cram
- Include short breaks between sessions
- For each session, suggest the specific study approach: review notes, practice problems, start writing, outline, etc.
- Be realistic about what one person can do
- If self-assessment data is present: allocate extra time for low-confidence topics, schedule review sessions for topics the student reported struggling with, and put courses with lower confidence earlier in the day when focus is highest
- If the student's top blocker is time pressure, build in tighter timeboxes and explicit "stop and move on" points
- If the student's top blocker is confusion, suggest starting sessions with a brief concept review before diving into assignments
- If confidence trend data shows improvement, maintain current study intensity. If declining, schedule more review time and shorter sessions to prevent burnout.
- If task completion stats are present, adjust plan density — if the student completed most tasks last week, maintain pace. If completion was low, create a lighter plan with fewer but more critical tasks.
- If on-time submission rate is below 80%, frontload deadline-adjacent work and add explicit "start early" sessions 2+ days before due dates.
- If plan follow-through data is present: high follow-through (>70%) → the student executes plans well, maintain current plan density. Low follow-through (<50%) → create a lighter plan with fewer, higher-priority tasks so they can actually complete everything.

FORMAT:
Organize by day. For each session:
[Time range] — [Course name]: [Specific task]
  Why: [1-sentence rationale]
  Approach: [How to study — review, practice, outline, etc.]

End with a brief "priorities" summary: what's most important and what can slip if time runs short.

Use plain text with line breaks. No markdown formatting.`;

  const result = streamText({
    model: openai("gpt-4o-mini"),
    system,
    messages: [
      {
        role: "user",
        content: mode === "day"
          ? "Plan my study sessions for today. What should I work on and when?"
          : "Plan my study sessions for this week. Help me stay on top of everything.",
      },
    ],
  });

  log.info("study plan streaming started", { mode });

  // Stream the response as plain text
  const stream = result.textStream;
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
    },
  });
}
