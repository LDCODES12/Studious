"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { TutorSession } from "@/components/study-tools/tutor-session";

function TutorContent() {
  const params = useSearchParams();

  const courseId = params.get("courseId") ?? undefined;
  const topicName = params.get("topic") ?? params.get("q") ?? undefined;
  const courseName = params.get("courseName") ?? undefined;
  const courseColor = params.get("courseColor") ?? undefined;
  const readingsParam = params.get("readings");
  const readings = readingsParam ? readingsParam.split("|||") : undefined;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TutorSession
        courseId={courseId}
        courseName={courseName}
        courseColor={courseColor}
        topicName={topicName}
        readings={readings}
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
