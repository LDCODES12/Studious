import crypto from "crypto";
import { db } from "@/lib/db";
import { generateEmbedding } from "@/lib/embeddings";
import { ensureTranscriptChunks } from "@/lib/transcript-chunks";

export type MaterialSourceKind =
  | "canvas_syllabus"
  | "canvas_module"
  | "canvas_media"
  | "manual_upload"
  | "auto_route"
  | "legacy";

export type MaterialSyncStatus = "ready" | "stale" | "failed";

export function normalizeSourceUpdatedAt(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function isRemoteSourceNewer(
  remoteUpdatedAt: string | Date | null | undefined,
  knownUpdatedAt: string | Date | null | undefined,
): boolean {
  const remote = normalizeSourceUpdatedAt(remoteUpdatedAt);
  if (!remote) return false;

  const known = normalizeSourceUpdatedAt(knownUpdatedAt);
  if (!known) return true;

  return remote.getTime() > known.getTime() + 1_000;
}

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

export async function ensureMaterialTranscriptChunks({
  materialId,
  courseId,
  sourceKind,
  text,
  contentHash,
}: {
  materialId: string;
  courseId: string;
  sourceKind: MaterialSourceKind;
  text: string;
  contentHash: string;
}): Promise<void> {
  if (sourceKind !== "canvas_media") return;
  await ensureTranscriptChunks({ materialId, courseId, text, contentHash });
}

export async function updateMaterialSearchIndex({
  materialId,
  courseId,
  sourceKind,
  text,
  contentHash,
}: {
  materialId: string;
  courseId: string;
  sourceKind: MaterialSourceKind;
  text: string;
  contentHash: string;
}): Promise<void> {
  await updateMaterialEmbedding(materialId, text);
  await ensureMaterialTranscriptChunks({ materialId, courseId, sourceKind, text, contentHash });
}
