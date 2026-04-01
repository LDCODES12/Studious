"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { TutorSession } from "@/components/study-tools/tutor-session";
import type { StudyTargetEvidence } from "@/lib/study-targets";

function parseEvidence(raw: string | null): StudyTargetEvidence | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as StudyTargetEvidence;
  } catch {
    return undefined;
  }
}

function TutorContent() {
  const params = useSearchParams();

  const courseId = params.get("courseId") ?? undefined;
  const topicName = params.get("topic") ?? params.get("q") ?? undefined;
  const courseName = params.get("courseName") ?? undefined;
  const courseColor = params.get("courseColor") ?? undefined;
  const readingsParam = params.get("readings");
  const readings = readingsParam ? readingsParam.split("|||") : undefined;
  const evidence = parseEvidence(params.get("evidence"));

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TutorSession
        courseId={courseId}
        courseName={courseName}
        courseColor={courseColor}
        topicName={topicName}
        readings={readings}
        targetEvidence={evidence}
      />
    </div>
  );
}

export default function TutorPage() {
  return (
    <Suspense>
      <TutorContent />
    </Suspense>
  );
}
