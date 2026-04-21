ALTER TABLE "CourseMaterialChunk"
ADD COLUMN IF NOT EXISTS "evidenceType" TEXT NOT NULL DEFAULT 'content',
ADD COLUMN IF NOT EXISTS "signals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "importance" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "CourseMaterialChunk_text_search_idx"
ON "CourseMaterialChunk"
USING gin (to_tsvector('english', "text"));

CREATE INDEX IF NOT EXISTS "CourseMaterialChunk_evidenceType_idx"
ON "CourseMaterialChunk"("evidenceType");

CREATE INDEX IF NOT EXISTS "CourseMaterialChunk_keywords_idx"
ON "CourseMaterialChunk"
USING gin ("keywords");

CREATE INDEX IF NOT EXISTS "CourseMaterialChunk_signals_idx"
ON "CourseMaterialChunk"
USING gin ("signals");
