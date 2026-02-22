import OpenAI from "openai";
import { db } from "@/lib/db";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function generateEmbedding(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text.slice(0, 8000),
  });
  return res.data[0].embedding;
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
