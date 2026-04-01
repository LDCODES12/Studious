# Database Query Reference

All queries use `npx tsx -e '...' 2>&1 | grep -v "warn\\|prisma"` pattern.

---

## 1. All Courses - Quick Summary

Shows every course with AI vs Module topic counts.

```bash
npx tsx -e '
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const courses = await db.course.findMany({ select: { id: true, name: true } });
  for (const c of courses) {
    const topics = await db.courseTopic.findMany({ where: { courseId: c.id }, orderBy: { weekNumber: "asc" }, select: { weekNumber: true, canvasModuleId: true, topics: true, startDate: true } });
    const ai = topics.filter(t => !t.canvasModuleId).length;
    const mod = topics.filter(t => t.canvasModuleId).length;
    console.log(c.name + " | " + topics.length + " total | " + ai + " AI | " + mod + " MODULE");
  }
}
main().then(() => db.$disconnect());
' 2>&1 | grep -v "warn\\|prisma"
```

---

## 2. All Courses - Detailed (every week, every course)

Full breakdown with week numbers, labels, dates, topic counts, and previews.

```bash
npx tsx -e '
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const courses = await db.course.findMany({ select: { id: true, name: true } });
  for (const course of courses) {
    const topics = await db.courseTopic.findMany({ where: { courseId: course.id }, orderBy: { weekNumber: "asc" }, select: { weekNumber: true, weekLabel: true, canvasModuleId: true, topics: true, startDate: true } });
    const ai = topics.filter(t => !t.canvasModuleId).length;
    const mod = topics.length - ai;
    console.log("\\n=== " + course.name + " === (" + topics.length + " total: " + ai + " AI, " + mod + " module)");
    for (const t of topics) {
      const src = t.canvasModuleId ? "MOD" : "AI ";
      const tc = t.topics ? t.topics.length : 0;
      const preview = t.topics && t.topics.length > 0 ? t.topics.slice(0, 2).join("; ").slice(0, 70) : "";
      console.log("  W" + t.weekNumber + " | " + src + " | " + (t.startDate || "no-date") + " | " + t.weekLabel + " | t=" + tc + " " + preview);
    }
  }
}
main().then(() => db.$disconnect());
' 2>&1 | grep -v "warn\\|prisma"
```

---

## 3. Single Course - Topics with Full Content

Replace `"Chem"` with course name. Excludes Lab variant.

```bash
npx tsx -e '
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const course = await db.course.findFirst({ where: { name: { contains: "Chem", mode: "insensitive" }, NOT: { name: { contains: "Lab", mode: "insensitive" } } }, select: { id: true, name: true } });
  if (course === null) { console.log("No course found"); return; }
  console.log("Course:", course.name);
  const topics = await db.courseTopic.findMany({ where: { courseId: course.id }, orderBy: { weekNumber: "asc" }, select: { weekNumber: true, weekLabel: true, canvasModuleId: true, topics: true, readings: true, startDate: true } });
  for (const t of topics) {
    console.log("---");
    console.log("W" + t.weekNumber + " | " + (t.canvasModuleId ? "MODULE" : "AI") + " | " + t.weekLabel + " | " + (t.startDate || "no-date"));
    console.log("  topics:", JSON.stringify(t.topics));
    console.log("  readings:", JSON.stringify(t.readings));
  }
  console.log("Total:", topics.length);
}
main().then(() => db.$disconnect());
' 2>&1 | grep -v "warn\\|prisma"
```

---

## 4. Course Materials - Stored Syllabus Files

Check what syllabus files are stored and their sizes.

```bash
npx tsx -e '
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const courses = await db.course.findMany({ select: { id: true, name: true } });
  for (const c of courses) {
    const mats = await db.courseMaterial.findMany({ where: { courseId: c.id }, select: { fileName: true, detectedType: true, rawText: true } });
    if (mats.length === 0) continue;
    console.log("\\n=== " + c.name + " ===");
    for (const m of mats) {
      console.log("  " + m.fileName + " | " + m.detectedType + " | " + (m.rawText ? m.rawText.length : 0) + " chars");
    }
  }
}
main().then(() => db.$disconnect());
' 2>&1 | grep -v "warn\\|prisma"
```

---

## 5. Single Course - Syllabus Text Sample

View the actual extracted text from a syllabus PDF. Useful for debugging extraction issues.

```bash
npx tsx -e '
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const course = await db.course.findFirst({ where: { name: { contains: "Chem", mode: "insensitive" }, NOT: { name: { contains: "Lab", mode: "insensitive" } } }, select: { id: true, name: true } });
  if (course === null) { console.log("No course found"); return; }
  const mat = await db.courseMaterial.findFirst({ where: { courseId: course.id, detectedType: "syllabus" }, select: { fileName: true, rawText: true } });
  if (mat && mat.rawText) {
    console.log(mat.fileName + ": " + mat.rawText.length + " chars total");
    console.log("\\n--- First 3000 chars ---");
    console.log(mat.rawText.slice(0, 3000));
    console.log("\\n--- Last 2000 chars ---");
    console.log(mat.rawText.slice(-2000));
  } else {
    console.log("No syllabus material found");
  }
}
main().then(() => db.$disconnect());
' 2>&1 | grep -v "warn\\|prisma"
```

---

## 6. Class Schedule - Meeting Times & Semester Dates

Check what class schedule was extracted for each course.

```bash
npx tsx -e '
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const courses = await db.course.findMany({ select: { name: true, classSchedule: true } });
  for (const c of courses) {
    const cs = c.classSchedule as any;
    if (!cs) { console.log(c.name + ": no classSchedule"); continue; }
    const meetings = (cs.meetings || []).map((m: any) => m.label + " " + (m.days || []).join("") + " " + m.startTime + "-" + m.endTime).join("; ");
    console.log(c.name + ": " + meetings + " | start=" + (cs.semesterStart ?? "null") + " end=" + (cs.semesterEnd ?? "null"));
  }
}
main().then(() => db.$disconnect());
' 2>&1 | grep -v "warn\\|prisma"
```

---

## 7. Drop Rules - Syllabus vs Canvas

Check which courses have syllabus-extracted drop rules vs Canvas-provided ones.

```bash
npx tsx -e '
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const groups = await db.assignmentGroup.findMany({ select: { name: true, dropLowest: true, dropHighest: true, syllabusDropLowest: true, syllabusDropHighest: true, course: { select: { name: true } } } });
  for (const g of groups) {
    if (g.dropLowest || g.dropHighest || g.syllabusDropLowest || g.syllabusDropHighest) {
      console.log(g.course.name + " | " + g.name + " | canvas: drop " + g.dropLowest + " low / " + g.dropHighest + " high | syllabus: drop " + g.syllabusDropLowest + " low / " + g.syllabusDropHighest + " high");
    }
  }
}
main().then(() => db.$disconnect());
' 2>&1 | grep -v "warn\\|prisma"
```

---

## 8. Syllabus Events - Extracted Dates

Check what dated events were extracted from syllabi (used by Gradescope import).

```bash
npx tsx -e '
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const courses = await db.course.findMany({ select: { name: true, syllabusEvents: true } });
  for (const c of courses) {
    const events = c.syllabusEvents as any[];
    if (!events || events.length === 0) { console.log(c.name + ": no syllabusEvents"); continue; }
    console.log("\\n=== " + c.name + " === (" + events.length + " events)");
    for (const e of events) {
      console.log("  " + (e.dueDate || "no-date") + " | " + e.type + " | " + e.title);
    }
  }
}
main().then(() => db.$disconnect());
' 2>&1 | grep -v "warn\\|prisma"
```

---

## 9. Syllabus Text - Search for Patterns

Find specific patterns in stored syllabus text (e.g., "Lecture N" references).

```bash
npx tsx -e '
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const course = await db.course.findFirst({ where: { name: { contains: "Chem", mode: "insensitive" }, NOT: { name: { contains: "Lab", mode: "insensitive" } } }, select: { id: true } });
  const mat = await db.courseMaterial.findFirst({ where: { courseId: course.id, detectedType: "syllabus" }, select: { rawText: true } });
  if (mat && mat.rawText) {
    const matches = mat.rawText.match(/Lecture\\s+\\d+/gi) || [];
    console.log("Lecture N matches:", matches.length);
    console.log(matches.join(", "));
  }
}
main().then(() => db.$disconnect());
' 2>&1 | grep -v "warn\\|prisma"
```

---

## 10. Delete AI Topics - Reset Before Re-sync

Deletes AI-generated topics for a specific course so the pipeline re-runs on next sync.

```bash
npx tsx -e '
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const course = await db.course.findFirst({ where: { name: { contains: "Chem", mode: "insensitive" }, NOT: { name: { contains: "Lab", mode: "insensitive" } } }, select: { id: true, name: true } });
  if (course === null) { console.log("No course found"); return; }
  const deleted = await db.courseTopic.deleteMany({ where: { courseId: course.id, canvasModuleId: null } });
  console.log("Deleted " + deleted.count + " AI topics from " + course.name);
}
main().then(() => db.$disconnect());
' 2>&1 | grep -v "warn\\|prisma"
```

---

## 11. Delete ALL Topics - Full Reset Before Re-sync

Deletes all topics (AI + module) for a course.

```bash
npx tsx -e '
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const course = await db.course.findFirst({ where: { name: { contains: "Chem", mode: "insensitive" }, NOT: { name: { contains: "Lab", mode: "insensitive" } } }, select: { id: true, name: true } });
  if (course === null) { console.log("No course found"); return; }
  const deleted = await db.courseTopic.deleteMany({ where: { courseId: course.id } });
  console.log("Deleted " + deleted.count + " total topics from " + course.name);
}
main().then(() => db.$disconnect());
' 2>&1 | grep -v "warn\\|prisma"
```

---

## Tips

- Always pipe through `2>&1 | grep -v "warn\\|prisma"` to suppress Prisma connection warnings
- Change course filter: `{ contains: "Calc" }`, `{ contains: "Anthro" }`, `{ contains: "Physio" }`, etc.
- To include Lab: remove the `NOT: { name: { contains: "Lab" } }` clause
- Pipeline skips courses that already have AI topics (`canvasModuleId = null`). Use query #10 to reset before re-syncing.
- `canvasModuleId = null` means AI-generated. Non-null means sourced from a Canvas module.
