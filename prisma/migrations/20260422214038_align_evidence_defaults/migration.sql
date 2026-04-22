-- AlterTable
ALTER TABLE "CourseEvidence" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "TutorConversation" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "CourseEvidencePlacement_evidenceId_placementKind_weekNumber_sta" RENAME TO "CourseEvidencePlacement_evidenceId_placementKind_weekNumber_key";
