import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

interface CourseMaterial {
  id: string;
  fileName: string;
  detectedType: string;
  summary: string;
  relatedTopics: string[];
  uploadedAt: string;
}

const typeLabels: Record<string, string> = {
  problem_set: "Problem Set",
  lecture_notes: "Lecture Notes",
  lecture_slides: "Lecture Slides",
  syllabus: "Syllabus",
  other: "Other",
};

const typeBadgeColor: Record<string, string> = {
  problem_set: "bg-orange-100 text-orange-700",
  lecture_notes: "bg-blue-100 text-blue-700",
  lecture_slides: "bg-purple-100 text-purple-700",
  syllabus: "bg-green-100 text-green-700",
  other: "bg-gray-100 text-gray-600",
};

export function MaterialCard({ material }: { material: CourseMaterial }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{material.fileName}</p>
          {material.summary && (
            <p className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">
              {material.summary}
            </p>
          )}
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
            typeBadgeColor[material.detectedType] ?? typeBadgeColor.other
          )}
        >
          {typeLabels[material.detectedType] ?? "Other"}
        </span>
      </div>

      {material.relatedTopics.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {material.relatedTopics.map((t, i) => (
            <span
              key={i}
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      <p className="mt-2 text-[11px] text-muted-foreground">
        {format(parseISO(material.uploadedAt), "MMM d, yyyy")}
      </p>
    </div>
  );
}
