ALTER TABLE "CourseMaterial"
ADD COLUMN IF NOT EXISTS "sourceKind" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN IF NOT EXISTS "sourceKey" TEXT,
ADD COLUMN IF NOT EXISTS "autoStoredForAI" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "userStoredForAIOverride" BOOLEAN,
ADD COLUMN IF NOT EXISTS "contentHash" TEXT,
ADD COLUMN IF NOT EXISTS "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "syncStatus" TEXT NOT NULL DEFAULT 'ready';

UPDATE "CourseMaterial"
SET "autoStoredForAI" = "storedForAI"
WHERE "sourceKind" = 'legacy'
  AND "userStoredForAIOverride" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "CourseMaterial_courseId_sourceKind_sourceKey_key"
ON "CourseMaterial"("courseId", "sourceKind", "sourceKey");

CREATE INDEX IF NOT EXISTS "CourseMaterial_courseId_sourceKind_idx"
ON "CourseMaterial"("courseId", "sourceKind");

ALTER TABLE "CanvasMaterialCandidate"
ADD COLUMN IF NOT EXISTS "sourceKind" TEXT NOT NULL DEFAULT 'canvas_module',
ADD COLUMN IF NOT EXISTS "remoteUpdatedAt" TEXT,
ADD COLUMN IF NOT EXISTS "remoteSize" INTEGER,
ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'discovered',
ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "CanvasMaterialCandidate"
SET "lastSeenAt" = COALESCE("lastSeenAt", CURRENT_TIMESTAMP);
