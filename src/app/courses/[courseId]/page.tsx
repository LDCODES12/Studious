import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { CourseHeader } from "@/components/course/course-header";
import { CourseTabs } from "@/components/course/course-tabs";
import { CourseSidebar } from "@/components/course/course-sidebar";

interface CoursePageProps {
  params: Promise<{ courseId: string }>;
}

export default async function CoursePage({ params }: CoursePageProps) {
  const { courseId } = await params;
  const session = await auth();
  if (!session?.user?.id) notFound();

  const cookieStore = await cookies();
  const googleConnected = !!cookieStore.get("google_tokens");

  const course = await db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
    include: {
      assignments: { orderBy: { dueDate: "asc" } },
      topics: { orderBy: { weekNumber: "asc" } },
      materials: { orderBy: { uploadedAt: "desc" } },
    },
  });

  if (!course) notFound();

  // Serialize Date fields for client components
  const materials = course.materials.map((m) => ({
    id: m.id,
    courseId: m.courseId,
    fileName: m.fileName,
    detectedType: m.detectedType,
    summary: m.summary,
    relatedTopics: m.relatedTopics,
    storedForAI: m.storedForAI,
    uploadedAt: m.uploadedAt.toISOString(),
  }));

  return (
    <div className="mx-auto max-w-[1200px] space-y-7">
      <CourseHeader course={course} courseId={course.id} />

      <div className="grid grid-cols-3 gap-7">
        <div className="col-span-2">
          <CourseTabs
            assignments={course.assignments}
            topics={course.topics}
            materials={materials}
            courseId={course.id}
            googleConnected={googleConnected}
          />
        </div>
        <div className="col-span-1">
          <CourseSidebar course={course} assignments={course.assignments} />
        </div>
      </div>
    </div>
  );
}
