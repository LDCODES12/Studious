import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface ParsedEvent {
  title: string;
  type: "assignment" | "exam" | "quiz" | "project" | "reading" | "lab" | "other";
  dueDate: string;
  courseName: string;
  description?: string;
}

export async function parseSyllabusText(text: string): Promise<ParsedEvent[]> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a syllabus parser. Extract every graded assessment (quizzes, exams, assignments, projects, labs) that has an explicitly written date in the syllabus. Include all of them — do not miss any.

WHAT TO INCLUDE:
- Every quiz date explicitly listed (check all tables, schedules, and regrade sections — they often contain quiz dates in a "Quiz Date" column)
- Every midterm and final exam date
- Every assignment or project with an explicit due date
- If a table lists quiz dates (e.g. a regrade request table with a "Quiz Date" column), extract each quiz as a separate quiz event using the date in that column

WHAT TO EXCLUDE:
- Regrade deadlines (e.g. "deadline for requesting a regrade") — these are NOT assessments
- Administrative events (e.g. "discussion subsections begin", "help sessions begin")
- Anything where dates are not written in the syllabus (e.g. "check Canvas for due dates")
- Non-graded readings, optional activities, office hours

RULES:
- Only use dates explicitly written in the syllabus text. Never estimate or extrapolate.
- Each quiz/exam should appear exactly once with its own date.
- If multiple quizzes are listed in a table, create one entry per quiz.
- Use the year from the syllabus header (e.g. Spring 2026 → year is 2026).

Return a JSON object with an "events" array. Each event must have:
- title: name of the assessment (e.g. "Quiz 1", "Midterm Exam 2", "Final Exam")
- type: one of "assignment", "exam", "quiz", "project", "lab", "other"
- dueDate: ISO date string (YYYY-MM-DD)
- courseName: course name/number from the syllabus header
- description: optional brief note (e.g. "6:30–8:00 pm, in person")`,
      },
      {
        role: "user",
        content: text,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return [];

  const parsed = JSON.parse(content);
  return parsed.events ?? [];
}

export interface ParsedTopic {
  weekNumber: number;
  weekLabel: string;
  startDate?: string;
  topics: string[];
  readings: string[];
  notes?: string;
  courseName: string;
}

export async function parseSyllabusTopics(text: string): Promise<ParsedTopic[]> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are an expert academic content extractor. Extract the COMPLETE week-by-week learning schedule from this syllabus — every topic, concept, lecture subject, and reading. Be exhaustive.

IMPORTANT: Syllabi organize content in many different ways. Handle all of them:
- Week-based: "Week 1: Introduction, Week 2: ..." → use directly
- Lecture-based: "Lecture 1, Lecture 2, ..." → group 2-3 lectures per week
- Date-based: Individual class session dates → calculate week numbers from the dates
- Module/unit-based: Group modules into sequential weeks
- Table format: Many syllabi use schedule tables — read every row

WHAT TO EXTRACT (be thorough):
- Every topic title, subtopic, and specific concept (e.g. "Big-O notation", "Dijkstra's algorithm", "The French Revolution", "protein folding")
- All readings: textbook chapters with numbers, papers, articles — include page ranges and chapter titles when listed
- Lab or recitation topics if different from lecture content
- Guest lectures, field trips, special sessions and their topics
- The start date for each week if you can determine it from dates in the schedule

WHAT NOT TO EXTRACT:
- Graded items with due dates (homework, quizzes, exams, projects) — those are handled separately
- Grading policies, office hours, late policy, attendance rules
- Administrative dates (registration deadlines, drop dates)

OUTPUT: Return JSON with a "weeks" array. Include EVERY week of the course — if it is a 15-week course, return 15 entries. Do not truncate or summarize. Each week must have:
- weekNumber: integer starting at 1
- weekLabel: 3-7 word description of the main theme (e.g. "Dynamic Programming and Memoization")
- startDate: ISO date YYYY-MM-DD if determinable, otherwise omit
- topics: COMPLETE array of ALL topics/concepts for this week — list every single one, do not shorten
- readings: COMPLETE array of ALL readings (chapter numbers, titles, page ranges, paper names)
- notes: optional — only for truly special notes like "No class — Spring Break" or "Lab meets in Room 204"
- courseName: exact course name/code from the syllabus header

If the syllabus genuinely contains no content schedule whatsoever, return {"weeks": []}.`,
      },
      { role: "user", content: text },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return [];
  const parsed = JSON.parse(content);
  return parsed.weeks ?? [];
}
