import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface MaterialAnalysis {
  detectedType: "problem_set" | "lecture_notes" | "lecture_slides" | "syllabus" | "other";
  summary: string;
  relatedTopics: string[];
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
