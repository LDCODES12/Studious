/**
 * Topic Pipeline: Multi-turn AI conversation for course content timelines.
 *
 * Philosophy: NEVER throw away data. Enhance and combine all sources.
 * Use as many AI calls as needed to produce the richest possible timeline.
 *
 * Architecture:
 *   1. COLLECT    — gather inputs (done by caller)
 *   2. CLASSIFY   — AI classifies Canvas modules as content/assessment/admin
 *   3. CONVERSATION — multi-turn Responses API:
 *      Turn 1: EXTRACT — per-lecture schedule from syllabus
 *      Turn 2: GROUP + DATE — group into calendar weeks, assign dates
 *      Turn 3: ENRICH — add module readings/content to matching weeks
 *   4. VALIDATE   — algorithmic sanity checks
 */

import OpenAI from "openai";
import {
  sanitizeSchedule,
  renumberSequentialWeeks,
  needsAudit,
  auditSchedule,
  bestWindow,
  detectSourceFormat,
  isContentfulTopic,
  type ParsedTopic,
} from "@/lib/parse-syllabus";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScoredSource {
  text: string;
  score: number;
  label: string;
}

export interface CanvasModuleInfo {
  id: string;
  canvasModuleId: string;
  weekNumber: number;
  weekLabel: string;
  topics: string[];
  readings: string[];
}

export interface ClassScheduleInfo {
  meetings: { label: string; days: string[]; startTime: string; endTime: string }[];
  semesterStart?: string | null;
  semesterEnd?: string | null;
}

export interface AssignmentDateInfo {
  title: string;
  dueDate: string | null;
}

export interface PipelineInput {
  courseId: string;
  courseName: string;
  candidates: ScoredSource[];
  modules: CanvasModuleInfo[];
  classSchedule: ClassScheduleInfo | null;
  termStartDate: string | null;
  termEndDate: string | null;
  assignments: AssignmentDateInfo[];
}

export interface PipelineResult {
  topics: ParsedTopic[];
  moduleIdsToDelete: string[];
  debug: PipelineDebug;
}

export interface PipelineDebug {
  stage2Classifications: { name: string; category: string }[];
  stage3Sources: number;
  stage3Weeks: number;
  conversationTurnsReached: number;
  conversationStateMode: "conversations_api" | "previous_response_id" | "none" | "mixed";
  stage5Warnings: string[];
  fallbackUsed: boolean;
}

// ─── Stage 2: CLASSIFY ──────────────────────────────────────────────────────

type ModuleCategory = "content" | "assessment" | "administrative";

async function classifyModules(
  moduleNames: string[],
): Promise<Map<string, ModuleCategory>> {
  if (moduleNames.length === 0) return new Map();

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini-2024-07-18",
      temperature: 0,
      seed: 1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You classify Canvas LMS module names into exactly one of three categories:

- "content": Modules that represent academic course content students learn (e.g. "Unit 1: Chemical Equilibria", "Week 3: The French Revolution", "Module 4 - Thermodynamics", "Intro to Linear Algebra").
- "assessment": Modules that are primarily containers for graded items (e.g. "Quiz", "Midterm", "Exam 2", "Final Project", "Homework Submissions").
- "administrative": Modules that are course logistics, tools, or orientation (e.g. "Orientation", "Welcome", "Course Information", "Aktiv Chemistry", "Piazza", "Discussion Module", "Syllabus", "Getting Started", "Zoom Links").

Rules:
- A module named like "Unit 1" or "Module 1" with NO descriptive subtitle is still "content" — it is a content container even without a topic name.
- Modules that combine content with assessment (e.g. "Week 5: Exam Review") are "content".
- When in doubt between content and administrative, prefer "content".
- Classify EVERY module in the input list.

Return JSON: { "classifications": [{ "name": "<exact module name>", "category": "content" | "assessment" | "administrative" }] }`,
        },
        { role: "user", content: JSON.stringify(moduleNames) },
      ],
    }, { timeout: 15_000 });

    const content = response.choices[0]?.message?.content;
    if (!content) return new Map();
    const parsed = JSON.parse(content);
    const map = new Map<string, ModuleCategory>();
    for (const item of (parsed.classifications ?? []) as { name: string; category: string }[]) {
      if (item.category === "content" || item.category === "assessment" || item.category === "administrative") {
        map.set(item.name, item.category);
      }
    }
    return map;
  } catch (err) {
    console.warn(`[pipeline] classifyModules failed, defaulting all to content:`, err);
    return new Map();
  }
}

// ─── System Prompts for Multi-Turn Conversation ─────────────────────────────

const EXTRACT_PROMPT = `You are an expert academic content extractor. Your job is to extract the week-by-week or lecture-by-lecture learning schedule from a course syllabus.

CRITICAL RULE — DO NOT HALLUCINATE: Only extract content that is EXPLICITLY written in the text as a schedule. If the text is primarily course policies, grading breakdowns, contact info, or administrative rules WITHOUT a clear topic schedule, return {"weeks": []}. Never invent or infer topics from the course name.

A real schedule looks like:
- "Week 1 (Jan 13): Introduction to Calculus, Limits"
- "Lecture 3: The French Revolution, Ch. 4"
- A table with dates/weeks in one column and topics in another

Course policies text (return empty for this):
- "Attendance Policy: ...", "Grading: 40% exams...", "Late work: -10% per day..."

SOURCE FORMAT HINTS: The input may begin with a [Source: ...] line describing the format.
- "structured schedule (one entry per line)" → each line is likely one week/lecture row; parse carefully
- "tab-separated table" → columns are tab-separated; first column is usually week/date, others are topic/readings
- "html-list" → bullet or numbered list items are individual schedule entries
- "paragraph text" → schedule may be embedded in prose; look harder for patterns
- "weekly calendar grid (7-column Sun-Sat; each row = one week; cells contain date + optional event text)" →
    The PDF extractor preserves the calendar structure: each calendar ROW becomes ONE text line,
    with TAB characters (\\t) separating the 7 day cells (Sun\\tMon\\tTue\\tWed\\tThu\\tFri\\tSat).
    Primary strategy — use the tab structure:
    1. Find the header line containing day names separated by tabs (Sun/Mon/.../Sat or full names).
    2. Each subsequent line = one week. Split on \\t to get the 7 day cells.
    3. Each cell may contain a date, an event name like "Experiment 1: Gas Constant", both, or be empty.
    4. Collect all event names from the 7 cells of that line → that is ONE week entry.
    5. Set startDate to the Monday date found in that line (YYYY-MM-DD).
    6. weekLabel = the main event name(s) (e.g. "Experiment 1: Gas Constant").
       Also add each event name to topics[] — e.g. topics: ["Experiment 1: Gas Constant"].
    7. If a cell says "No experiment", "No class", "MLK Day" etc., record it as notes for that week.
    Fallback (if tab structure is garbled or absent): scan for named events near dates using proximity.
    CRITICAL: Return an empty array ONLY if there are literally zero event names in the entire text.

IMPORTANT: Syllabi organize content in many different ways. Handle all of them:
- Week-based: "Week 1: Introduction, Week 2: ..." → use directly, one entry per week
- Lecture-based: "Lecture 1, Lecture 2, ..." → extract EACH LECTURE as its own entry (weekNumber = lecture number). Do NOT group or collapse lectures together — output every single lecture separately so downstream processing can group them accurately using the class schedule.
- Date-based: Individual class session dates → one entry per session, weekNumber = sequential
- Module/unit-based: One entry per module/unit, weekNumber = sequential
- Table format: Many syllabi use schedule tables — read every row, one entry per row
- Calendar grid: 7-column Sun-Sat physical calendar → PDF garbles the structure; use proximity-scan to find named events near dates

WHAT TO EXTRACT:
- Every topic title, subtopic, and specific concept explicitly listed in the schedule
- All readings: textbook chapters with numbers, papers, articles — include page ranges and chapter titles when listed
- Lab or recitation topics if different from lecture content
- The start date for each week if you can determine it from dates in the schedule
- Class meeting dates even when NO topic names are listed (e.g. a seminar that only provides meeting dates) — include these sessions with notes = "No topics listed — class meeting date" so the date survives as a calendar marker. Set weekLabel to something like "Seminar Session 1", "Meeting 1", etc.

WHAT NOT TO EXTRACT:
- Graded items with due dates (homework, quizzes, exams, projects) — those are handled separately
- Grading policies, office hours, late policy, attendance rules
- Administrative dates (registration deadlines, drop dates)

OUTPUT: Return JSON with a "weeks" array. If you find a real schedule, include EVERY week — do not truncate. Each week must have:
- weekNumber: integer starting at 1
- weekLabel: 3-7 word description of the PRIMARY TOPIC(S) covered — must name actual subjects (e.g. "Dynamic Programming and Memoization", "The French Revolution, Causes"). NEVER use "Week 1", "Regular Class", "TBD", or any placeholder. If a week has only a break note use that (e.g. "Spring Break — No Class"). For date-only sessions use descriptive labels like "Seminar Session 1".
- startDate: ISO date YYYY-MM-DD if determinable, otherwise omit
- topics: array of ALL topics/concepts for this week
- readings: array of ALL readings (chapter numbers, titles, page ranges, paper names)
- notes: optional — for special notes like "No class — Spring Break", OR "No topics listed — class meeting date" for date-only sessions
- courseName: exact course name/code from the syllabus header

If you cannot find an explicit schedule, return {"weeks": []}.`;

const GROUP_DATE_PROMPT = `You are a course schedule organizer. You previously extracted a lecture-by-lecture or session-by-session schedule from a syllabus. Now you must GROUP those entries into calendar weeks and ASSIGN real dates.

You will receive:
- meetingPattern: the class meeting schedule (e.g. "Lecture MO WE FR 09:00-09:50" means 3 lectures per week on Monday, Wednesday, Friday)
- semesterStartFromSchedule: semester start date extracted from the syllabus/class schedule (may be null)
- semesterStartFromCanvas: semester start date from Canvas LMS term data (may be null)
- semesterEndFromSchedule: semester end date from syllabus (may be null)
- semesterEndFromCanvas: semester end date from Canvas (may be null)
- assignmentDates: known graded item dates from Canvas — use these as anchoring points

YOUR TASK:
1. Determine the semester start date. Use the EARLIER of the two provided start dates (it is likely the actual first day of classes). If only one is available, use that.
2. Count lecture days per week from the meeting pattern (e.g. MO WE FR = 3 lectures/week, TU TH = 2/week). If unknown, default to 3/week.
3. Starting from Week 1 (the Monday of the week containing the semester start), map each lecture from your previous extraction to its calendar week. Lecture 1 falls on the first lecture day of the semester, Lecture 2 on the next lecture day, etc.
4. Group all lectures falling in the same calendar week into ONE week entry.
5. For each grouped week:
   - weekNumber: sequential starting at 1
   - startDate: the Monday of that calendar week (YYYY-MM-DD)
   - topics: combine topics from all lectures in this week. Prefix each with its lecture number for detail (e.g. "Lec 1: Introduction to equilibrium, Law of Mass Action", "Lec 2: Equilibrium constant, manipulation of K values")
   - readings: combine readings from all lectures (deduplicate exact matches)
   - weekLabel: 3-7 word summary of the week's primary topic(s)
   - notes: include break notes if applicable (e.g. "Spring Break — No Class")
   - courseName: same as from your extraction

IMPORTANT RULES:
- Do NOT drop any lectures from your previous extraction. Every single lecture must appear in exactly one week.
- Account for common academic breaks: if there is a week-long gap suggested by assignment dates or standard academic calendars (spring break typically in March), insert a break week.
- If the semester end date is not available, assume a standard 15-16 week semester.
- startDates must be chronological Mondays.
- Use assignment due dates as reality checks — if Quiz 1 is on Jan 29, topics before that date should make sense chronologically.

OUTPUT: Return JSON with { "weeks": [...] }
Each week: { weekNumber, weekLabel, startDate, topics: [...], readings: [...], notes (optional), courseName }`;

const ENRICH_PROMPT = `You enrich a course timeline with additional data from Canvas LMS modules.

You will receive Canvas module data: module names and their content items (topics, readings like slides, handouts, worksheets, etc.)

You have full context of the course timeline you just created. Your job:
- Match each Canvas module to the corresponding week(s) by topic/unit overlap
- ADD useful readings from modules (slides, handouts, worksheets, problem sets) to the matching week's readings array
- If a module mentions content not covered in any week's topics, ADD it as a new topic entry in the most appropriate week
- KEEP all existing topics, dates, weekNumbers, and weekLabels EXACTLY as they are — do not rename, summarize, reorder, or remove anything
- If you cannot match a module to any week, skip it — do not force it

OUTPUT: Return the complete updated timeline as JSON with { "weeks": [...] }
Same structure: { weekNumber, weekLabel, startDate, topics, readings, notes (optional), courseName }`;

// ─── Multi-Turn Conversation ────────────────────────────────────────────────

interface ConversationResult {
  extractedTopics: ParsedTopic[]; // Turn 1 result (for quality check)
  finalTopics: ParsedTopic[];     // Best result from Turn 2 or 3
  turnsReached: number;
  label: string;
  window: string; // for audit pass
  stateMode: "conversations_api" | "previous_response_id";
}

async function runConversation(
  candidate: ScoredSource,
  courseName: string,
  classSchedule: ClassScheduleInfo | null,
  termStartDate: string | null,
  termEndDate: string | null,
  assignments: AssignmentDateInfo[],
  contentModules: CanvasModuleInfo[],
): Promise<ConversationResult> {
  const FULL_TEXT_THRESHOLD = 30_000;
  const LARGE_WINDOW_SIZE = 20_000;

  const win = candidate.text.length <= FULL_TEXT_THRESHOLD
    ? candidate.text
    : bestWindow(candidate.text, LARGE_WINDOW_SIZE);

  const fmt = detectSourceFormat(candidate.text);
  const hint = `${candidate.label}, format: ${fmt}`;
  const userContent = `Extract the course schedule from this syllabus and return JSON.\n\n[Source: ${hint}]\n\n${win}`;

  // Calendar grid format → gpt-4o for spatial reasoning, everything else → gpt-4o-mini
  const isCalendarGrid = fmt.includes("weekly calendar grid");
  const model = isCalendarGrid ? "gpt-4o-2024-08-06" : "gpt-4o-mini-2024-07-18";

  // Prefer durable Conversations API state. If unavailable, fall back to
  // previous_response_id chaining so the flow still works.
  let conversationId: string | null = null;
  let stateMode: "conversations_api" | "previous_response_id" = "previous_response_id";
  let previousResponseId: string | null = null;

  const convT0 = Date.now();
  try {
    const conv = await openai.conversations.create({
      metadata: {
        pipeline: "topic-pipeline",
        courseName: courseName.slice(0, 120),
        sourceLabel: candidate.label.slice(0, 120),
      },
    }, { timeout: 10_000 });
    conversationId = conv.id;
    stateMode = "conversations_api";
    console.log(`[pipeline] ${courseName} conversation created (${Date.now() - convT0}ms) id=${conv.id}`);
  } catch (err) {
    console.warn(`[pipeline] ${courseName} conversation create FAILED (${Date.now() - convT0}ms), falling back to previous_response_id:`, String(err));
  }

  let turnCounter = 0;
  const runTurn = async (args: {
    model: string;
    instructions: string;
    input: string;
  }) => {
    const turnNum = ++turnCounter;
    const turnT0 = Date.now();
    const stateParam = conversationId ? "conversation" : (previousResponseId ? "prev_response_id" : "none");
    console.log(`[pipeline] ${courseName} Turn ${turnNum} START (model=${args.model}, state=${stateParam}, inputLen=${args.input.length})`);
    const response = await openai.responses.create({
      model: args.model,
      ...(conversationId
        ? { conversation: conversationId }
        : (previousResponseId ? { previous_response_id: previousResponseId } : {})),
      instructions: args.instructions,
      input: args.input,
      text: { format: { type: "json_object" } },
      temperature: 0,
      store: true,
      truncation: "auto",
    }, { timeout: 45_000 });
    previousResponseId = response.id;
    console.log(`[pipeline] ${courseName} Turn ${turnNum} DONE (${Date.now() - turnT0}ms, responseLen=${response.output_text.length}, id=${response.id})`);
    return response;
  };

  // ── Turn 1: EXTRACT (with retry) ──
  let turn1;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      turn1 = await runTurn({
        model,
        instructions: EXTRACT_PROMPT,
        input: userContent,
      });
      break;
    } catch (err: any) {
      const isLocked = err?.status === 400 && String(err?.message ?? err).includes("conversation_locked");
      if (attempt === 0) {
        if (isLocked && conversationId) {
          console.warn(`[pipeline] ${courseName} Turn 1 conversation_locked — abandoning conversation ${conversationId}, switching to previous_response_id mode`);
          conversationId = null;
          stateMode = "previous_response_id";
        } else {
          console.warn(`[pipeline] ${courseName} Turn 1 attempt 1 failed, retrying in 5s:`, err);
        }
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        console.error(`[pipeline] ${courseName} Turn 1 failed after 2 attempts:`, err);
        return {
          extractedTopics: [],
          finalTopics: [],
          turnsReached: 0,
          label: candidate.label,
          window: win,
          stateMode,
        };
      }
    }
  }

  const turn1Parsed = parseResponseJSON<{ weeks: ParsedTopic[] }>(turn1!.output_text);
  const rawTopics = turn1Parsed?.weeks ?? [];
  const extractedTopics = sanitizeSchedule(rawTopics).filter(isContentfulTopic);

  console.log(`[pipeline] ${courseName} Turn 1 EXTRACT (${candidate.label}, ${model}): ${extractedTopics.length} entries from ${candidate.text.length}ch`);

  if (extractedTopics.length === 0) {
    return {
      extractedTopics: [],
      finalTopics: [],
      turnsReached: 1,
      label: candidate.label,
      window: win,
      stateMode,
    };
  }

  // ── Turn 2: GROUP + DATE ──
  try {
    const lectureMeetings = classSchedule?.meetings
      .filter((m) => m.label.toLowerCase() === "lecture") ?? [];

    const meetingPattern = lectureMeetings.length > 0
      ? lectureMeetings
          .map((m) => `${m.label} ${m.days.join(" ")} ${m.startTime}-${m.endTime}`)
          .join("; ")
      : "unknown (assume MWF 3 lectures per week)";

    const scheduleInfo = {
      meetingPattern,
      semesterStartFromSchedule: classSchedule?.semesterStart ?? null,
      semesterStartFromCanvas: termStartDate,
      semesterEndFromSchedule: classSchedule?.semesterEnd ?? null,
      semesterEndFromCanvas: termEndDate,
      assignmentDates: assignments
        .filter((a) => a.dueDate)
        .slice(0, 30)
        .map((a) => ({ title: a.title, date: a.dueDate })),
    };

    const turn2 = await runTurn({
      model: "gpt-4o-mini-2024-07-18",
      instructions: GROUP_DATE_PROMPT,
      input: `Group these lectures into calendar weeks and return JSON.\n\n${JSON.stringify(scheduleInfo)}`,
    });

    const turn2Parsed = parseResponseJSON<{ weeks: ParsedTopic[] }>(turn2.output_text);
    const groupedTopics = turn2Parsed?.weeks ?? [];

    console.log(`[pipeline] ${courseName} Turn 2 GROUP+DATE: ${groupedTopics.length} weeks (from ${extractedTopics.length} lectures)`);

    if (groupedTopics.length === 0) {
      // Turn 2 failed to produce anything — fall back to Turn 1
      return {
        extractedTopics,
        finalTopics: extractedTopics,
        turnsReached: 2,
        label: candidate.label,
        window: win,
        stateMode,
      };
    }

    // ── Turn 3: ENRICH (only if content modules exist) ──
    if (contentModules.length > 0) {
      try {
        const moduleData = contentModules.map((m) => ({
          moduleName: m.weekLabel,
          topics: m.topics,
          readings: m.readings,
        }));

        const turn3 = await runTurn({
          model: "gpt-4o-mini-2024-07-18",
          instructions: ENRICH_PROMPT,
          input: `Enrich the timeline with these Canvas modules and return JSON.\n\n${JSON.stringify({ canvasModules: moduleData })}`,
        });

        const turn3Parsed = parseResponseJSON<{ weeks: ParsedTopic[] }>(turn3.output_text);
        const enrichedTopics = turn3Parsed?.weeks ?? [];

        console.log(`[pipeline] ${courseName} Turn 3 ENRICH: ${enrichedTopics.length} weeks (with ${contentModules.length} modules)`);

        // Safety: enriched must have roughly same number of weeks as grouped
        if (enrichedTopics.length >= groupedTopics.length * 0.8 && enrichedTopics.length <= groupedTopics.length * 1.2) {
          return {
            extractedTopics,
            finalTopics: enrichedTopics,
            turnsReached: 3,
            label: candidate.label,
            window: win,
            stateMode,
          };
        }
        console.warn(`[pipeline] ${courseName} Turn 3 produced ${enrichedTopics.length} weeks vs ${groupedTopics.length} grouped — using Turn 2 result`);
      } catch (err: any) {
        const isLocked = err?.status === 400 && String(err?.message ?? err).includes("conversation_locked");
        if (isLocked && conversationId) {
          console.warn(`[pipeline] ${courseName} Turn 3 conversation_locked — abandoning conversation, retrying with previous_response_id`);
          conversationId = null;
          stateMode = "previous_response_id";
          try {
            const turn3Retry = await runTurn({
              model: "gpt-4o-mini-2024-07-18",
              instructions: ENRICH_PROMPT,
              input: `Enrich the timeline with these Canvas modules and return JSON.\n\n${JSON.stringify({ canvasModules: contentModules.map((m) => ({ moduleName: m.weekLabel, topics: m.topics, readings: m.readings })) })}`,
            });
            const retryParsed = parseResponseJSON<{ weeks: ParsedTopic[] }>(turn3Retry.output_text);
            const retryTopics = retryParsed?.weeks ?? [];
            if (retryTopics.length >= groupedTopics.length * 0.8 && retryTopics.length <= groupedTopics.length * 1.2) {
              return { extractedTopics, finalTopics: retryTopics, turnsReached: 3, label: candidate.label, window: win, stateMode };
            }
          } catch (retryErr) {
            console.warn(`[pipeline] ${courseName} Turn 3 retry also failed:`, retryErr);
          }
        } else {
          console.warn(`[pipeline] ${courseName} Turn 3 failed, using Turn 2 result:`, err);
        }
      }
    }

    // No modules or Turn 3 failed — use Turn 2 result
    return {
      extractedTopics,
      finalTopics: groupedTopics,
      turnsReached: contentModules.length > 0 ? 3 : 2,
      label: candidate.label,
      window: win,
      stateMode,
    };

  } catch (err: any) {
    const isLocked = err?.status === 400 && String(err?.message ?? err).includes("conversation_locked");
    if (isLocked && conversationId) {
      console.warn(`[pipeline] ${courseName} Turn 2 conversation_locked — abandoning conversation, retrying with previous_response_id`);
      conversationId = null;
      stateMode = "previous_response_id";
      // Retry Turn 2 once without conversation
      try {
        const lectureMeetings = classSchedule?.meetings
          .filter((m) => m.label.toLowerCase() === "lecture") ?? [];
        const meetingPattern = lectureMeetings.length > 0
          ? lectureMeetings.map((m) => `${m.label} ${m.days.join(" ")} ${m.startTime}-${m.endTime}`).join("; ")
          : "unknown (assume MWF 3 lectures per week)";
        const scheduleInfo = {
          meetingPattern,
          semesterStartFromSchedule: classSchedule?.semesterStart ?? null,
          semesterStartFromCanvas: termStartDate,
          semesterEndFromSchedule: classSchedule?.semesterEnd ?? null,
          semesterEndFromCanvas: termEndDate,
          assignmentDates: assignments.filter((a) => a.dueDate).slice(0, 30).map((a) => ({ title: a.title, date: a.dueDate })),
        };
        const turn2Retry = await runTurn({
          model: "gpt-4o-mini-2024-07-18",
          instructions: GROUP_DATE_PROMPT,
          input: `Group these lectures into calendar weeks and return JSON.\n\n${JSON.stringify(scheduleInfo)}`,
        });
        const retryParsed = parseResponseJSON<{ weeks: ParsedTopic[] }>(turn2Retry.output_text);
        const retryTopics = retryParsed?.weeks ?? [];
        if (retryTopics.length > 0) {
          return { extractedTopics, finalTopics: retryTopics, turnsReached: 2, label: candidate.label, window: win, stateMode };
        }
      } catch (retryErr) {
        console.warn(`[pipeline] ${courseName} Turn 2 retry also failed:`, retryErr);
      }
    } else {
      console.warn(`[pipeline] ${courseName} Turn 2 failed, using Turn 1 result:`, err);
    }
    return {
      extractedTopics,
      finalTopics: extractedTopics,
      turnsReached: 2,
      label: candidate.label,
      window: win,
      stateMode,
    };
  }
}

function parseResponseJSON<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ─── Candidate Loop + Merge ─────────────────────────────────────────────────

async function extractAndGroupFromCandidates(
  candidates: ScoredSource[],
  courseName: string,
  classSchedule: ClassScheduleInfo | null,
  termStartDate: string | null,
  termEndDate: string | null,
  assignments: AssignmentDateInfo[],
  contentModules: CanvasModuleInfo[],
): Promise<{
  topics: ParsedTopic[];
  usedLabel: string;
  turnsReached: number;
  stateMode: "conversations_api" | "previous_response_id" | "none" | "mixed";
}> {

  const allGoodResults: {
    result: ParsedTopic[];
    label: string;
    win: string;
    turns: number;
    stateMode: "conversations_api" | "previous_response_id";
  }[] = [];

  for (let ci = 0; ci < candidates.length; ci++) {
    // Add delay between candidates to avoid OpenAI conversation_locked rate limits
    if (ci > 0) {
      console.log(`[pipeline] ${courseName} waiting 3s before candidate[${ci}]`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    const conv = await runConversation(
      candidates[ci], courseName, classSchedule,
      termStartDate, termEndDate, assignments, contentModules,
    );

    // Quality-check based on Turn 1 extraction
    // A week is "rich" if it has topics, readings, or a meaningful weekLabel (not just "Week N")
    const hasRichLabel = (label?: string) =>
      !!label && label.trim().length > 0 && !/^(week|module|unit|lecture)\s*\d+$/i.test(label.trim());
    const richWeeks = conv.extractedTopics.filter(
      (t) => (t.topics ?? []).length > 0 || (t.readings ?? []).length > 0 || hasRichLabel(t.weekLabel),
    ).length;
    const isGoodResult = conv.extractedTopics.length > 0 &&
      (conv.extractedTopics.length < 4 || richWeeks / conv.extractedTopics.length >= 0.3);

    console.log(`[pipeline] ${courseName} candidate[${ci}] ${conv.label}: ${conv.extractedTopics.length} extracted, ${conv.finalTopics.length} final (${conv.turnsReached} turns) → ${isGoodResult ? "ACCEPTED" : "rejected"}`);

    if (isGoodResult && conv.finalTopics.length > 0) {
      allGoodResults.push({
        result: conv.finalTopics,
        label: conv.label,
        win: conv.window,
        turns: conv.turnsReached,
        stateMode: conv.stateMode,
      });
    }
  }

  if (allGoodResults.length === 0) {
    return { topics: [], usedLabel: "none", turnsReached: 0, stateMode: "none" };
  }

  // Merge: start with highest-coverage source, fill gaps from others
  allGoodResults.sort((a, b) => b.result.length - a.result.length);
  const merged = new Map<number, ParsedTopic>();
  const sourceLabels: string[] = [];
  const stateModes = new Set<"conversations_api" | "previous_response_id">();
  let usedWindow = allGoodResults[0].win;
  let maxTurns = 0;

  for (const { result, label, turns, stateMode } of allGoodResults) {
    let contributed = false;
    maxTurns = Math.max(maxTurns, turns);
    stateModes.add(stateMode);
    for (const week of result) {
      const existing = merged.get(week.weekNumber);
      if (!existing) {
        merged.set(week.weekNumber, week);
        contributed = true;
      } else {
        const existingRich = (existing.topics?.length ?? 0) + (existing.readings?.length ?? 0);
        const newRich = (week.topics?.length ?? 0) + (week.readings?.length ?? 0);
        if (newRich > existingRich) {
          merged.set(week.weekNumber, { ...week, startDate: existing.startDate ?? week.startDate });
          contributed = true;
        } else if (!existing.startDate && week.startDate) {
          existing.startDate = week.startDate;
          contributed = true;
        }
      }
    }
    if (contributed) sourceLabels.push(label);
  }

  let topics = [...merged.values()].sort((a, b) => a.weekNumber - b.weekNumber);
  const usedLabel = sourceLabels.length > 1
    ? `merged(${sourceLabels.join("+")})`
    : sourceLabels[0] ?? "none";

  // Audit pass — fires when result looks partial/messy
  if (needsAudit(topics)) {
    const audited = await auditSchedule(topics, usedWindow);
    if (audited.length > 0) {
      topics = audited;
    }
  }

  topics = renumberSequentialWeeks(topics);

  const mergedMode =
    stateModes.size === 0
      ? "none"
      : stateModes.size === 1
        ? [...stateModes][0]
        : "mixed";

  return { topics, usedLabel, turnsReached: maxTurns, stateMode: mergedMode };
}

// ─── Stage 5: VALIDATE ──────────────────────────────────────────────────────

function validateTimeline(
  topics: ParsedTopic[],
  termStart: string | null,
  termEnd: string | null,
): { topics: ParsedTopic[]; warnings: string[] } {
  const warnings: string[] = [];

  if (topics.length === 0) {
    warnings.push("Pipeline produced 0 topics");
    return { topics, warnings };
  }

  // 1. Ensure weekNumbers are sequential starting at 1
  topics = renumberSequentialWeeks(topics);

  // 2. Check dates are chronological
  const dated = topics.filter(
    (t) => t.startDate && /^\d{4}-\d{2}-\d{2}$/.test(t.startDate!),
  );
  for (let i = 1; i < dated.length; i++) {
    if (dated[i].startDate! < dated[i - 1].startDate!) {
      warnings.push(
        `Non-chronological: week ${dated[i].weekNumber} (${dated[i].startDate}) before week ${dated[i - 1].weekNumber} (${dated[i - 1].startDate})`,
      );
      dated[i].startDate = undefined;
    }
  }

  // 3. Check for large gaps (> 21 days)
  for (let i = 1; i < dated.length; i++) {
    if (dated[i].startDate && dated[i - 1].startDate) {
      const gap =
        (new Date(dated[i].startDate!).getTime() - new Date(dated[i - 1].startDate!).getTime()) /
        86400_000;
      if (gap > 21) {
        warnings.push(
          `Large gap: ${Math.round(gap)} days between weeks ${dated[i - 1].weekNumber} and ${dated[i].weekNumber}`,
        );
      }
    }
  }

  // 4. Check dates within term bounds
  if (termStart && termEnd) {
    for (const t of dated) {
      if (t.startDate! < termStart || t.startDate! > termEnd) {
        warnings.push(`Date ${t.startDate} for week ${t.weekNumber} outside term ${termStart}..${termEnd}`);
      }
    }
  }

  // 5. Check for placeholder labels
  for (const t of topics) {
    if (!t.weekLabel || t.weekLabel.trim() === "" || /^week\s+\d+$/i.test(t.weekLabel)) {
      warnings.push(`Weak weekLabel "${t.weekLabel}" on week ${t.weekNumber}`);
    }
  }

  // 6. Check week count is reasonable (flag if >18 or <4)
  if (topics.length > 18) {
    warnings.push(`Too many weeks (${topics.length}) — semester is typically 14-16 weeks`);
  }

  return { topics, warnings };
}

// ─── Module-Only Fallback: organize modules into a timeline ─────────────────

function organizeModulesAsTimeline(
  contentModules: CanvasModuleInfo[],
  courseName: string,
): ParsedTopic[] {
  if (contentModules.length === 0) return [];

  // Parse unit number and lecture range from each module label
  const parsed = contentModules.map((m) => {
    const label = m.weekLabel;

    const unitMatch = label.match(/\b(?:unit|module|week)\s*(\d+)/i);
    const unitNum = unitMatch ? parseInt(unitMatch[1], 10) : null;

    const lecMatch = label.match(/lectures?\s*(\d+)\s*[-–]\s*(\d+)/i);
    const lecStart = lecMatch ? parseInt(lecMatch[1], 10) : null;
    const lecEnd = lecMatch ? parseInt(lecMatch[2], 10) : null;

    let cleanLabel = label
      .replace(/\s*-\s*(quiz\s+on\s+\S+|no\s+quiz|exam\s+on\s+\S+)/i, "")
      .replace(/\s*\(lectures?\s*\d+\s*[-–]\s*\d+\)/i, "")
      .trim();

    if (/^unit\s+\d+$/i.test(cleanLabel)) {
      cleanLabel = `Unit ${unitNum}`;
    }

    return { module: m, unitNum, lecStart, lecEnd, cleanLabel };
  });

  // Sort by unit number, then by first lecture number
  parsed.sort((a, b) => {
    if (a.unitNum !== null && b.unitNum !== null) return a.unitNum - b.unitNum;
    if (a.unitNum !== null) return -1;
    if (b.unitNum !== null) return 1;
    if (a.lecStart !== null && b.lecStart !== null) return a.lecStart - b.lecStart;
    return 0;
  });

  const USEFUL_READING_RX = /slide|worksheet|handout|problem\s+set|packet|review|derivation|video|reading/i;
  const SKIP_READING_RX = /\b(quiz|exam)\s+(blank|key)\b|regrade\s+request|setup\s+instructions|gradescope/i;

  const timeline: ParsedTopic[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];

    const SKIP_TOPIC_RX = /^(assignments?|homework|quiz\s+information|quiz\s+and\s+exam|suggested\s+readings?|lecture\s+powerpoint|section\s+\d|quiz\s+policies|exam\s+room)/i;
    const usefulTopics = p.module.topics.filter((t) => !SKIP_TOPIC_RX.test(t));

    const usefulReadings = p.module.readings.filter(
      (r) => USEFUL_READING_RX.test(r) && !SKIP_READING_RX.test(r),
    );

    timeline.push({
      weekNumber: i + 1,
      weekLabel: p.cleanLabel,
      topics: usefulTopics.length > 0
        ? usefulTopics
        : p.lecStart !== null && p.lecEnd !== null
          ? [`Lectures ${p.lecStart}–${p.lecEnd}`]
          : [],
      readings: usefulReadings,
      courseName,
    });
  }

  console.log(`[pipeline] ${courseName}: module fallback organized ${contentModules.length} modules → ${timeline.length} timeline entries`);
  return timeline;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export async function runTopicPipeline(input: PipelineInput): Promise<PipelineResult> {
  const debug: PipelineDebug = {
    stage2Classifications: [],
    stage3Sources: input.candidates.length,
    stage3Weeks: 0,
    conversationTurnsReached: 0,
    conversationStateMode: "none",
    stage5Warnings: [],
    fallbackUsed: false,
  };

  // ── STAGE 2: CLASSIFY modules ──
  const moduleClassifications = input.modules.length > 0
    ? await classifyModules(input.modules.map((m) => m.weekLabel))
    : new Map<string, ModuleCategory>();

  debug.stage2Classifications = input.modules.map((m) => ({
    name: m.weekLabel,
    category: moduleClassifications.get(m.weekLabel) ?? "content",
  }));

  const contentModules = input.modules.filter(
    (m) => (moduleClassifications.get(m.weekLabel) ?? "content") === "content",
  );
  const nonContentModuleIds = input.modules
    .filter((m) => {
      const cat = moduleClassifications.get(m.weekLabel);
      return cat === "assessment" || cat === "administrative";
    })
    .map((m) => m.id);

  console.log(
    `[pipeline] ${input.courseName}: Stage 2 classified ${input.modules.length} modules → ` +
    `${contentModules.length} content, ${nonContentModuleIds.length} non-content`,
  );

  // ── STAGE 3: MULTI-TURN CONVERSATION (Extract → Group+Date → Enrich) ──
  const { topics: aiTopics, usedLabel, turnsReached, stateMode } = await extractAndGroupFromCandidates(
    input.candidates,
    input.courseName,
    input.classSchedule,
    input.termStartDate,
    input.termEndDate,
    input.assignments,
    contentModules,
  );

  debug.stage3Weeks = aiTopics.length;
  debug.conversationTurnsReached = turnsReached;
  debug.conversationStateMode = stateMode;

  console.log(
    `[pipeline] ${input.courseName}: Conversation produced ${aiTopics.length} weeks from ${input.candidates.length} source(s) ` +
    `(${turnsReached} turns, mode=${stateMode}, label: ${usedLabel})`,
  );

  // ── Determine final topics + module deletion ──
  let finalTopics: ParsedTopic[];
  let moduleIdsToDelete: string[];

  if (aiTopics.length === 0 && contentModules.length === 0) {
    finalTopics = [];
    moduleIdsToDelete = [];
    debug.fallbackUsed = true;
    console.log(`[pipeline] ${input.courseName}: No data from either source`);

  } else if (aiTopics.length === 0) {
    // No AI topics — organize modules as timeline fallback
    const organizedModules = organizeModulesAsTimeline(contentModules, input.courseName);
    if (organizedModules.length > 0) {
      finalTopics = organizedModules;
      moduleIdsToDelete = input.modules.map((m) => m.id);
      debug.fallbackUsed = true;
      console.log(`[pipeline] ${input.courseName}: Module-only fallback → ${organizedModules.length} entries`);
    } else {
      finalTopics = [];
      moduleIdsToDelete = nonContentModuleIds;
      debug.fallbackUsed = true;
      console.log(`[pipeline] ${input.courseName}: No AI topics, keeping ${contentModules.length} content modules`);
    }

  } else {
    finalTopics = aiTopics;
    moduleIdsToDelete = input.modules.map((m) => m.id);
  }

  // ── STAGE 5: VALIDATE ──
  const validated = validateTimeline(finalTopics, input.termStartDate, input.termEndDate);
  debug.stage5Warnings = validated.warnings;

  if (validated.warnings.length > 0) {
    console.warn(`[pipeline] ${input.courseName}: validation warnings:`, validated.warnings);
  }

  return {
    topics: validated.topics,
    moduleIdsToDelete,
    debug,
  };
}
