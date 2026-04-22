CREATE TABLE IF NOT EXISTS "CourseEvidence" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "bodyText" TEXT,
  "structuredPayload" JSONB,
  "provenance" JSONB NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "remoteUpdatedAt" TIMESTAMP(3),
  "contentHash" TEXT,
  "derivedHints" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "embedding" vector(1536),

  CONSTRAINT "CourseEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CourseEvidenceChunk" (
  "id" TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "charStart" INTEGER NOT NULL,
  "charEnd" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "tokenEstimate" INTEGER NOT NULL,
  "evidenceType" TEXT NOT NULL DEFAULT 'content',
  "signals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "importance" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "embedding" vector(1536),

  CONSTRAINT "CourseEvidenceChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CourseEvidencePlacement" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  "placementKind" TEXT NOT NULL,
  "weekNumber" INTEGER,
  "weekLabel" TEXT,
  "startDate" TEXT,
  "confidence" TEXT NOT NULL DEFAULT 'unknown',
  "rationale" TEXT,
  "signals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CourseEvidencePlacement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CourseEvidence_courseId_sourceKey_key"
ON "CourseEvidence"("courseId", "sourceKey");

CREATE INDEX IF NOT EXISTS "CourseEvidence_courseId_sourceKind_idx"
ON "CourseEvidence"("courseId", "sourceKind");

CREATE INDEX IF NOT EXISTS "CourseEvidence_courseId_remoteUpdatedAt_idx"
ON "CourseEvidence"("courseId", "remoteUpdatedAt");

CREATE INDEX IF NOT EXISTS "CourseEvidence_embedding_hnsw_idx"
ON "CourseEvidence"
USING hnsw ("embedding" vector_cosine_ops)
WHERE "embedding" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "CourseEvidenceChunk_evidenceId_chunkIndex_key"
ON "CourseEvidenceChunk"("evidenceId", "chunkIndex");

CREATE INDEX IF NOT EXISTS "CourseEvidenceChunk_courseId_idx"
ON "CourseEvidenceChunk"("courseId");

CREATE INDEX IF NOT EXISTS "CourseEvidenceChunk_evidenceId_idx"
ON "CourseEvidenceChunk"("evidenceId");

CREATE INDEX IF NOT EXISTS "CourseEvidenceChunk_evidenceId_contentHash_idx"
ON "CourseEvidenceChunk"("evidenceId", "contentHash");

CREATE INDEX IF NOT EXISTS "CourseEvidenceChunk_courseId_evidenceId_idx"
ON "CourseEvidenceChunk"("courseId", "evidenceId");

CREATE INDEX IF NOT EXISTS "CourseEvidenceChunk_embedding_hnsw_idx"
ON "CourseEvidenceChunk"
USING hnsw ("embedding" vector_cosine_ops)
WHERE "embedding" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "CourseEvidencePlacement_evidenceId_placementKind_weekNumber_sta_key"
ON "CourseEvidencePlacement"("evidenceId", "placementKind", "weekNumber", "startDate");

CREATE INDEX IF NOT EXISTS "CourseEvidencePlacement_courseId_placementKind_idx"
ON "CourseEvidencePlacement"("courseId", "placementKind");

CREATE INDEX IF NOT EXISTS "CourseEvidencePlacement_courseId_weekNumber_idx"
ON "CourseEvidencePlacement"("courseId", "weekNumber");

CREATE INDEX IF NOT EXISTS "CourseEvidencePlacement_evidenceId_idx"
ON "CourseEvidencePlacement"("evidenceId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'CourseEvidence_courseId_fkey'
  ) THEN
    ALTER TABLE "CourseEvidence"
    ADD CONSTRAINT "CourseEvidence_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'CourseEvidenceChunk_evidenceId_fkey'
  ) THEN
    ALTER TABLE "CourseEvidenceChunk"
    ADD CONSTRAINT "CourseEvidenceChunk_evidenceId_fkey"
    FOREIGN KEY ("evidenceId") REFERENCES "CourseEvidence"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'CourseEvidenceChunk_courseId_fkey'
  ) THEN
    ALTER TABLE "CourseEvidenceChunk"
    ADD CONSTRAINT "CourseEvidenceChunk_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'CourseEvidencePlacement_courseId_fkey'
  ) THEN
    ALTER TABLE "CourseEvidencePlacement"
    ADD CONSTRAINT "CourseEvidencePlacement_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'CourseEvidencePlacement_evidenceId_fkey'
  ) THEN
    ALTER TABLE "CourseEvidencePlacement"
    ADD CONSTRAINT "CourseEvidencePlacement_evidenceId_fkey"
    FOREIGN KEY ("evidenceId") REFERENCES "CourseEvidence"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
