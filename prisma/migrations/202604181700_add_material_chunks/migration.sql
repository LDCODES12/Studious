CREATE TABLE IF NOT EXISTS "CourseMaterialChunk" (
  "id" TEXT NOT NULL,
  "materialId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "charStart" INTEGER NOT NULL,
  "charEnd" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "tokenEstimate" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "embedding" vector(1536),

  CONSTRAINT "CourseMaterialChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CourseMaterialChunk_materialId_chunkIndex_key"
ON "CourseMaterialChunk"("materialId", "chunkIndex");

CREATE INDEX IF NOT EXISTS "CourseMaterialChunk_courseId_idx"
ON "CourseMaterialChunk"("courseId");

CREATE INDEX IF NOT EXISTS "CourseMaterialChunk_materialId_idx"
ON "CourseMaterialChunk"("materialId");

CREATE INDEX IF NOT EXISTS "CourseMaterialChunk_materialId_contentHash_idx"
ON "CourseMaterialChunk"("materialId", "contentHash");

CREATE INDEX IF NOT EXISTS "CourseMaterialChunk_courseId_materialId_idx"
ON "CourseMaterialChunk"("courseId", "materialId");

CREATE INDEX IF NOT EXISTS "CourseMaterialChunk_embedding_hnsw_idx"
ON "CourseMaterialChunk"
USING hnsw ("embedding" vector_cosine_ops)
WHERE "embedding" IS NOT NULL;

ALTER TABLE "CourseMaterialChunk"
ADD CONSTRAINT "CourseMaterialChunk_materialId_fkey"
FOREIGN KEY ("materialId") REFERENCES "CourseMaterial"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
