import { generateObject } from "ai";
import { modelConfig } from "@/lib/ai-models";
import { z } from "zod";

const materialTypeEnum = z.enum([
  "problem_set", "lecture_notes", "lecture_slides", "textbook", "syllabus", "other",
]);

export interface MaterialAnalysis {
  detectedType: "problem_set" | "lecture_notes" | "lecture_slides" | "textbook" | "syllabus" | "other";
  summary: string;
  relatedTopics: string[];
}

export type MaterialSourceRole = "timeline" | "content" | "mixed" | "unknown";

export interface AutoRouteResult {
  courseId: string | null;
  detectedType: MaterialAnalysis["detectedType"];
  storedForAI: boolean;
  summary: string;
  relatedTopics: string[];
}

const autoRouteSchema = z.object({
  courseId: z.string().nullable(),
  detectedType: materialTypeEnum,
  storedForAI: z.boolean(),
  summary: z.string(),
  relatedTopics: z.array(z.string()),
});

const materialAnalysisSchema = z.object({
  detectedType: materialTypeEnum,
  summary: z.string(),
  relatedTopics: z.array(z.string()),
});

const DEFAULT_ROUTE: AutoRouteResult = {
  courseId: null, detectedType: "other", storedForAI: false,
  summary: "Unable to analyze document.", relatedTopics: [],
};

const DEFAULT_ANALYSIS: MaterialAnalysis = {
  detectedType: "other", summary: "Unable to analyze document.", relatedTopics: [],
};

export async function autoRouteMaterial(
  text: string,
  courses: { id: string; name: string; topicLabels: string[] }[]
): Promise<AutoRouteResult> {
  const courseList = courses.map((c) => ({
    id: c.id,
    name: c.name,
    topics: c.topicLabels.slice(0, 30),
  }));

  try {
    const { object } = await generateObject({
      ...modelConfig("low"),
      schema: autoRouteSchema,
      system: `You are a student assistant that routes uploaded course materials to the correct course.

Given a document and a list of the student's courses, determine:
1. Which course this document belongs to (match by subject matter, course name, or topic overlap)
2. What type of document it is
3. Whether it should be stored for AI quiz generation

Return:
- courseId: the id string of the matching course, or null if no good match
- detectedType: one of "lecture_notes", "lecture_slides", "textbook", "problem_set", "syllabus", "other"
- storedForAI: true if lecture_notes, lecture_slides, or textbook (rich study content useful for quizzes); false otherwise
- summary: 1-2 sentence description of the document content (max 200 chars)
- relatedTopics: array of specific topic strings from the matched course's topics list that this document covers (empty array if no match or no relevant topics)

Student's courses: ${JSON.stringify(courseList)}`,
      prompt: text.slice(0, 8000),
      abortSignal: AbortSignal.timeout(20_000),
    });

    return object;
  } catch {
    return DEFAULT_ROUTE;
  }
}

export async function analyzeCourseMaterial(
  text: string,
  topicLabels: string[]
): Promise<MaterialAnalysis> {
  try {
    const { object } = await generateObject({
      ...modelConfig("low"),
      schema: materialAnalysisSchema,
      system: `You are a course material analyzer. Classify the document type and summarize its relevance to the course.

Return:
- detectedType: one of "problem_set", "lecture_notes", "lecture_slides", "syllabus", "other"
- summary: 1-2 sentences describing what this document contains and how it relates to the course (max 200 characters)
- relatedTopics: array of topic labels from the provided list that this document is relevant to (can be empty)

Available topic labels: ${JSON.stringify(topicLabels)}

Only use labels from the provided list in relatedTopics. If the list is empty, return an empty array.`,
      prompt: text.slice(0, 8000),
      abortSignal: AbortSignal.timeout(20_000),
    });

    return object;
  } catch {
    return DEFAULT_ANALYSIS;
  }
}

export function inferMaterialSourceRole(
  detectedType: MaterialAnalysis["detectedType"],
  label?: string | null,
): MaterialSourceRole {
  const normalizedLabel = label?.toLowerCase() ?? "";
  if (/\bstudy\s+outline\b|\breview\s+questions?\b|\bexam\s+\d+\b|\bmidterm\b/.test(normalizedLabel)) {
    return "content";
  }
  if (detectedType === "syllabus" && /\bsyllab|schedule|calendar\b/.test(normalizedLabel)) return "timeline";
  if (detectedType === "syllabus") return "mixed";
  if (detectedType === "lecture_notes" || detectedType === "lecture_slides" || detectedType === "textbook") {
    return "content";
  }
  if (detectedType === "problem_set") return "content";
  return "unknown";
}
