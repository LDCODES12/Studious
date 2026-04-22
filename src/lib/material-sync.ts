import crypto from "crypto";

export type MaterialSourceKind =
  | "canvas_syllabus"
  | "canvas_syllabus_page"
  | "canvas_module"
  | "canvas_page"
  | "canvas_announcement"
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
