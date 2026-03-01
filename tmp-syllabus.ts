import { config } from "dotenv";
config({ path: ".env.local" });
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

async function main() {
  const course = await db.course.findFirst({
    where: { name: { contains: "Physio", mode: "insensitive" } },
    select: { id: true },
  });
  if (!course) return;
  const mat = await db.courseMaterial.findFirst({
    where: { courseId: course.id, detectedType: "syllabus", fileName: { contains: "Syllabus" } },
    select: { fileName: true, rawText: true },
  });
  if (mat && mat.rawText) {
    console.log(mat.fileName + ": " + mat.rawText.length + " chars");
    console.log("\n--- FULL TEXT ---");
    console.log(mat.rawText);
  } else {
    console.log("No syllabus found");
  }
}
main().then(() => db.$disconnect());
