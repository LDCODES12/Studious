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

  const [course, courseTasks] = await Promise.all([db.course.findFirst({
    where: { id: courseId, userId: session.user.id },
    include: {
      assignments: { orderBy: { dueDate: "asc" } },
      assignmentGroups: {
        orderBy: { position: "asc" },
        include: {
          assignments: {
            orderBy: { dueDate: "asc" },
            select: {
              id: true, title: true, score: true, pointsPossible: true,
              status: true, dueDate: true,
              excused: true, omitFromFinalGrade: true, canvasAssignmentId: true,
              missing: true, late: true,
              gradescopeScore: true, gradescopeMaxScore: true,
            },
          },
        },
      },
      topics: { orderBy: { weekNumber: "asc" } },
      materials: { orderBy: { uploadedAt: "desc" } },
      announcements: { orderBy: { postedAt: "desc" }, take: 10 },
    },
  }), db.task.findMany({
    where: { courseId, userId: session.user.id, completed: false },
    orderBy: { dueDate: "asc" },
    take: 5,
    select: { id: true, title: true, dueDate: true, priority: true, source: true },
  })]);

  if (!course) notFound();

  // Serialize for client components
  const assignments = course.assignments.map((a) => ({
    id: a.id,
    title: a.title,
    dueDate: a.dueDate,
    status: a.status,
    type: a.type,
    googleEventId: a.googleEventId,
    courseId: a.courseId,
    score: a.score,
    pointsPossible: a.pointsPossible,
    canvasUrl: a.canvasUrl,
    missing: a.missing,
  }));

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

  const announcements = course.announcements.map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    postedAt: a.postedAt,
  }));

  return (
    <div className="mx-auto max-w-[1200px] space-y-7">
      <CourseHeader course={course} courseId={course.id} />

      <div className="grid grid-cols-3 gap-7">
        <div className="col-span-2">
          <CourseTabs
            assignments={assignments}
            assignmentGroups={course.assignmentGroups}
            courseTasks={courseTasks}
            announcements={announcements}
            currentGrade={course.currentGrade}
            currentScore={course.currentScore}
            gradingScheme={course.gradingScheme as { name: string; value: number }[] | null}
            applyGroupWeights={course.applyGroupWeights}
            topics={course.topics}
            materials={materials}
            courseId={course.id}
            googleConnected={googleConnected}
          />
        </div>
        <div className="col-span-1">
          <CourseSidebar
            course={course}
            assignments={assignments}
            announcements={announcements}
          />
        </div>
      </div>
    </div>
  );
}
