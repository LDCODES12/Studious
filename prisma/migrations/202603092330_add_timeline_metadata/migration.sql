ALTER TABLE "Course"
ADD COLUMN "timelineMode" TEXT DEFAULT 'unknown',
ADD COLUMN "timelineDiagnostics" JSONB;

ALTER TABLE "CourseTopic"
ADD COLUMN "dateConfidence" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN "contentConfidence" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN "scheduleMode" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN "provenance" JSONB;

ALTER TABLE "CourseMaterial"
ADD COLUMN "sourceRole" TEXT NOT NULL DEFAULT 'unknown';

CREATE TABLE "CourseTimelineAnchor" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "sequenceNumber" INTEGER NOT NULL,
  "anchorDate" TEXT,
  "anchorType" TEXT NOT NULL,
  "isInstructional" BOOLEAN NOT NULL DEFAULT true,
  "calendarConfidence" TEXT NOT NULL DEFAULT 'unknown',
  "sourceRefs" JSONB,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CourseTimelineAnchor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourseTimelineAnchor_courseId_sequenceNumber_key"
ON "CourseTimelineAnchor"("courseId", "sequenceNumber");

ALTER TABLE "CourseTimelineAnchor"
ADD CONSTRAINT "CourseTimelineAnchor_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "CourseMaterial"
SET "sourceRole" = CASE
  WHEN "detectedType" = 'syllabus' THEN 'mixed'
  WHEN "detectedType" IN ('lecture_notes', 'lecture_slides', 'textbook', 'problem_set') THEN 'content'
  ELSE 'unknown'
END
WHERE "sourceRole" = 'unknown';

UPDATE "CourseTopic"
SET
  "scheduleMode" = CASE
    WHEN "startDate" IS NOT NULL THEN 'weekly'
    ELSE 'inferred'
  END,
  "dateConfidence" = CASE
    WHEN "startDate" IS NOT NULL THEN 'medium'
    ELSE 'unknown'
  END,
  "contentConfidence" = CASE
    WHEN cardinality("topics") > 0 OR cardinality("readings") > 0 THEN 'medium'
    ELSE 'low'
  END
WHERE "scheduleMode" = 'unknown';

UPDATE "Course"
SET "timelineMode" = COALESCE((
  SELECT CASE
    WHEN COUNT(*) FILTER (WHERE "scheduleMode" = 'sparse') > 0 THEN 'sparse'
    WHEN COUNT(*) FILTER (WHERE "scheduleMode" = 'weekly') > 0 THEN 'weekly'
    WHEN COUNT(*) FILTER (WHERE "scheduleMode" = 'inferred') > 0 THEN 'inferred'
    ELSE 'unknown'
  END
  FROM "CourseTopic"
  WHERE "CourseTopic"."courseId" = "Course"."id"
), 'unknown')
WHERE "timelineMode" IS NULL;
