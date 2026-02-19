import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { autoRouteMaterial } from "@/lib/analyze-material";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { files } = (await request.json()) as {
    files: { name: string; text: string }[];
  };

  if (!files || files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  // Fetch user's courses with topic labels for AI context
  const courses = await db.course.findMany({
    where: { userId: session.user.id },
    include: { topics: { select: { topics: true } } },
  });

  const courseContext = courses.map((c) => ({
    id: c.id,
    name: c.name,
    topicLabels: c.topics.flatMap((t) => t.topics),
  }));

  const results = await Promise.all(
    files.map(async (file) => {
      const analysis = await autoRouteMaterial(file.text, courseContext);

      // Only save if we matched a course
      if (!analysis.courseId) {
        return {
          fileName: file.name,
          course: null,
          detectedType: analysis.detectedType,
          storedForAI: analysis.storedForAI,
          summary: analysis.summary,
          relatedTopics: analysis.relatedTopics,
          error: "Could not match to any of your courses.",
        };
      }

      // Verify the courseId belongs to this user
      const course = courses.find((c) => c.id === analysis.courseId);
      if (!course) {
        return {
          fileName: file.name,
          course: null,
          detectedType: analysis.detectedType,
          storedForAI: analysis.storedForAI,
          summary: analysis.summary,
          relatedTopics: analysis.relatedTopics,
          error: "Could not match to any of your courses.",
        };
      }

      await db.courseMaterial.create({
        data: {
          courseId: analysis.courseId,
          fileName: file.name,
          detectedType: analysis.detectedType,
          summary: analysis.summary,
          relatedTopics: analysis.relatedTopics,
          rawText: file.text.slice(0, 10000),
          storedForAI: analysis.storedForAI,
        },
      });

      return {
        fileName: file.name,
        course: { id: course.id, name: course.name, color: course.color },
        detectedType: analysis.detectedType,
        storedForAI: analysis.storedForAI,
        summary: analysis.summary,
        relatedTopics: analysis.relatedTopics,
        error: null,
      };
    })
  );

  return NextResponse.json({ results });
}
