CREATE TABLE IF NOT EXISTS "TutorConversation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "courseId" TEXT,
  "topicName" TEXT,
  "title" TEXT NOT NULL,
  "preview" TEXT,
  "readings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "targetEvidence" JSONB,
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastResponseId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TutorConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TutorMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "responseId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TutorMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TutorConversation_userId_updatedAt_idx"
ON "TutorConversation"("userId", "updatedAt");

CREATE INDEX IF NOT EXISTS "TutorConversation_userId_lastMessageAt_idx"
ON "TutorConversation"("userId", "lastMessageAt");

CREATE INDEX IF NOT EXISTS "TutorConversation_userId_courseId_topicName_idx"
ON "TutorConversation"("userId", "courseId", "topicName");

CREATE INDEX IF NOT EXISTS "TutorMessage_conversationId_createdAt_idx"
ON "TutorMessage"("conversationId", "createdAt");

ALTER TABLE "TutorConversation"
ADD CONSTRAINT "TutorConversation_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TutorConversation"
ADD CONSTRAINT "TutorConversation_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "Course"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TutorMessage"
ADD CONSTRAINT "TutorMessage_conversationId_fkey"
FOREIGN KEY ("conversationId") REFERENCES "TutorConversation"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
