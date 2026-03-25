import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import { db } from "@/lib/db";

export async function generateEmbedding(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: openai.embedding("text-embedding-3-small"),
    value: text.slice(0, 8000),
  });
  return embedding;
}

export async function searchMaterials(
  courseId: string,
  queryVector: number[],
  limit = 3
): Promise<{ id: string; fileName: string; rawText: string }[]> {
  const vectorStr = JSON.stringify(queryVector);
  const results = await db.$queryRaw<
    { id: string; fileName: string; rawText: string }[]
  >`
    SELECT id, "fileName", "rawText"
    FROM "CourseMaterial"
    WHERE "courseId" = ${courseId}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${limit}
  `;
  return results;
}
