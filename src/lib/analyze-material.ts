import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface MaterialAnalysis {
  detectedType: "problem_set" | "lecture_notes" | "lecture_slides" | "textbook" | "syllabus" | "other";
  summary: string;
  relatedTopics: string[];
}

export interface AutoRouteResult {
  courseId: string | null;
  detectedType: MaterialAnalysis["detectedType"];
  storedForAI: boolean;
  summary: string;
  relatedTopics: string[];
}

export async function autoRouteMaterial(
  text: string,
  courses: { id: string; name: string; topicLabels: string[] }[]
): Promise<AutoRouteResult> {
  const courseList = courses.map((c) => ({
    id: c.id,
    name: c.name,
    topics: c.topicLabels.slice(0, 30),
  }));

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a student assistant that routes uploaded course materials to the correct course.

Given a document and a list of the student's courses, determine:
1. Which course this document belongs to (match by subject matter, course name, or topic overlap)
2. What type of document it is
3. Whether it should be stored for AI quiz generation

Return JSON with:
- courseId: the id string of the matching course, or null if no good match
- detectedType: one of "lecture_notes", "lecture_slides", "textbook", "problem_set", "syllabus", "other"
- storedForAI: boolean — true if lecture_notes, lecture_slides, or textbook (rich study content useful for quizzes); false otherwise
- summary: 1-2 sentence description of the document content (max 200 chars)
- relatedTopics: array of specific topic strings from the matched course's topics list that this document covers (empty array if no match or no relevant topics)

Student's courses: ${JSON.stringify(courseList)}`,
      },
      {
        role: "user",
        content: text.slice(0, 8000),
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return { courseId: null, detectedType: "other", storedForAI: false, summary: "Unable to analyze document.", relatedTopics: [] };

  try {
    return JSON.parse(content) as AutoRouteResult;
  } catch {
    return { courseId: null, detectedType: "other", storedForAI: false, summary: "Unable to analyze document.", relatedTopics: [] };
  }
}

export async function analyzeCourseMaterial(
  text: string,
  topicLabels: string[]
): Promise<MaterialAnalysis> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a course material analyzer. Classify the document type and summarize its relevance to the course.

Return JSON with:
- detectedType: one of "problem_set", "lecture_notes", "lecture_slides", "syllabus", "other"
- summary: 1-2 sentences describing what this document contains and how it relates to the course (max 200 characters)
- relatedTopics: array of topic labels from the provided list that this document is relevant to (can be empty)

Available topic labels: ${JSON.stringify(topicLabels)}

Only use labels from the provided list in relatedTopics. If the list is empty, return an empty array.`,
      },
      {
        role: "user",
        content: text.slice(0, 8000),
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return { detectedType: "other", summary: "Unable to analyze document.", relatedTopics: [] };

  try {
    return JSON.parse(content) as MaterialAnalysis;
  } catch {
    return { detectedType: "other", summary: "Unable to analyze document.", relatedTopics: [] };
  }
}
