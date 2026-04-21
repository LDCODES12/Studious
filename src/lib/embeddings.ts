import { embed, embedMany } from "ai";
import { openai } from "@ai-sdk/openai";
import { db } from "@/lib/db";

const EMBEDDING_INPUT_MAX_CHARS = 8_000;

export async function generateEmbedding(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: openai.embedding("text-embedding-3-small"),
    value: text.slice(0, EMBEDDING_INPUT_MAX_CHARS),
  });
  return embedding;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { embeddings } = await embedMany({
    model: openai.embedding("text-embedding-3-small"),
    values: texts.map((text) => text.slice(0, EMBEDDING_INPUT_MAX_CHARS)),
  });
  return embeddings;
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

export async function getMaterialsByIds(
  courseId: string,
  ids: string[]
): Promise<{ id: string; fileName: string; rawText: string }[]> {
  if (ids.length === 0) return [];

  const materials = await db.courseMaterial.findMany({
    where: {
      courseId,
      id: { in: ids },
    },
    select: {
      id: true,
      fileName: true,
      rawText: true,
    },
  });

  const byId = new Map(materials.map((material) => [material.id, material]));
  return ids.map((id) => byId.get(id)).filter((material): material is { id: string; fileName: string; rawText: string } => !!material);
}
