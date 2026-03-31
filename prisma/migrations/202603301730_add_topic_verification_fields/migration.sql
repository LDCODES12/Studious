ALTER TABLE "CourseTopic"
ADD COLUMN IF NOT EXISTS "verificationStatus" TEXT NOT NULL DEFAULT 'unverified';

ALTER TABLE "CourseTopic"
ADD COLUMN IF NOT EXISTS "sourceBlock" TEXT;

UPDATE "CourseTimelineAnchor"
SET "anchorType" = 'syllabus_unverified'
WHERE "anchorType" IN ('explicit_date', 'inferred_week', 'sparse_meeting', 'lecture_group');

UPDATE "CourseTimelineAnchor"
SET "anchorType" = 'canvas_only'
WHERE "anchorType" = 'module_scaffold';
