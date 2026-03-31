import crypto from "crypto";
import { db } from "@/lib/db";
import { generateEmbedding } from "@/lib/embeddings";

export type MaterialSourceKind =
  | "canvas_syllabus"
  | "canvas_module"
  | "manual_upload"
  | "auto_route"
  | "legacy";

export type MaterialSyncStatus = "ready" | "stale" | "failed";

export function hashMaterialText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function effectiveStoredForAI(
  autoStoredForAI: boolean,
  userStoredForAIOverride: boolean | null | undefined,
): boolean {
  return userStoredForAIOverride ?? autoStoredForAI;
}

export async function updateMaterialEmbedding(
  materialId: string,
  text: string,
): Promise<void> {
  const vector = await generateEmbedding(text);
  await db.$executeRaw`
    UPDATE "CourseMaterial"
    SET embedding = ${JSON.stringify(vector)}::vector
    WHERE id = ${materialId}
  `;
}
