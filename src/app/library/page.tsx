import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { LibraryUploader } from "@/components/library/library-uploader";

export default async function LibraryPage() {
  const session = await auth();
  if (!session?.user?.id) notFound();

  const courses = await db.course.findMany({
    where: { userId: session.user.id },
    select: { id: true, name: true, color: true },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Library</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Drop any course material — notes, slides, textbooks, problem sets. AI will classify and place them in the right course.
        </p>
      </div>
      <LibraryUploader courses={courses} />
    </div>
  );
}
