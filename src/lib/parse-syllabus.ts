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
