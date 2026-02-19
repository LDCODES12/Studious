"use client";

import { useState, useRef } from "react";
import { cn } from "@/lib/utils";
import { courseColors } from "@/lib/constants";
import { extractTextFromPDF } from "@/lib/extract-pdf-text";

interface Course {
  id: string;
  name: string;
  color: string;
}

interface UploadResult {
  fileName: string;
  course: { id: string; name: string; color: string } | null;
  detectedType: string;
  storedForAI: boolean;
  summary: string;
  relatedTopics: string[];
  error: string | null;
}

const typeLabels: Record<string, string> = {
  lecture_notes: "Lecture Notes",
  lecture_slides: "Slides",
  textbook: "Textbook",
  problem_set: "Problem Set",
  syllabus: "Syllabus",
  other: "Other",
};

const typeBadgeColor: Record<string, string> = {
  lecture_notes: "bg-blue-50 text-blue-700 border-blue-200",
  lecture_slides: "bg-purple-50 text-purple-700 border-purple-200",
  textbook: "bg-indigo-50 text-indigo-700 border-indigo-200",
  problem_set: "bg-orange-50 text-orange-700 border-orange-200",
  syllabus: "bg-green-50 text-green-700 border-green-200",
  other: "bg-gray-50 text-gray-600 border-gray-200",
};

export function LibraryUploader({ courses }: { courses: Course[] }) {
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("");
  const [results, setResults] = useState<UploadResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: File[]) => {
    const pdfs = files.filter((f) => f.type === "application/pdf" || f.name.endsWith(".pdf"));
    if (pdfs.length === 0) {
      setError("Please upload PDF files only.");
      return;
    }

    setError(null);
    setLoading(true);
    setLoadingLabel(`Extracting text from ${pdfs.length} file${pdfs.length > 1 ? "s" : ""}...`);

    try {
      const extracted = await Promise.all(
        pdfs.map(async (f) => ({ name: f.name, text: await extractTextFromPDF(f) }))
      );

      setLoadingLabel(`Analyzing ${pdfs.length} file${pdfs.length > 1 ? "s" : ""} with AI...`);

      const res = await fetch("/api/upload/auto-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: extracted }),
      });

      if (!res.ok) throw new Error("Upload failed");

      const data = await res.json();
      setResults((prev) => [...(data.results as UploadResult[]), ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setLoading(false);
      setLoadingLabel("");
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(Array.from(e.target.files));
  };

  if (courses.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
        <p className="text-[13px] text-muted-foreground">
          Upload a syllabus first to create your courses, then come back to add materials.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "relative flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors",
          dragging
            ? "border-foreground/40 bg-accent/40"
            : "border-border hover:border-foreground/30 hover:bg-accent/20"
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf"
          multiple
          className="hidden"
          onChange={onInputChange}
        />
        {loading ? (
          <p className="text-[13px] text-muted-foreground">{loadingLabel}</p>
        ) : (
          <>
            <p className="text-[13px] font-medium">Drop PDFs here or click to browse</p>
            <p className="text-[12px] text-muted-foreground">
              Notes, slides, textbooks, problem sets — AI will route to the right course
            </p>
          </>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-3">
          <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
            Uploaded
          </p>
          {results.map((r, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{r.fileName}</p>
                  {r.course ? (
                    <div className="mt-1 flex items-center gap-1.5">
                      <span
                        className={cn(
                          "h-2 w-2 rounded-full",
                          courseColors[r.course.color]?.dot ?? "bg-gray-400"
                        )}
                      />
                      <a
                        href={`/courses/${r.course.id}`}
                        className="text-[12px] text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {r.course.name}
                      </a>
                    </div>
                  ) : (
                    <p className="mt-1 text-[12px] text-red-500">{r.error}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <span
                    className={cn(
                      "rounded border px-2 py-0.5 text-[11px] font-medium",
                      typeBadgeColor[r.detectedType] ?? typeBadgeColor.other
                    )}
                  >
                    {typeLabels[r.detectedType] ?? r.detectedType}
                  </span>
                  <span
                    className={cn(
                      "rounded border px-2 py-0.5 text-[11px] font-medium",
                      r.storedForAI
                        ? "border-purple-200 bg-purple-50 text-purple-700"
                        : "border-gray-200 bg-gray-50 text-gray-500"
                    )}
                  >
                    {r.storedForAI ? "Study material" : "Reference"}
                  </span>
                </div>
              </div>
              {r.summary && (
                <p className="text-[12px] text-muted-foreground">{r.summary}</p>
              )}
              {r.relatedTopics.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {r.relatedTopics.map((t, j) => (
                    <span
                      key={j}
                      className="rounded bg-accent px-2 py-0.5 text-[11px] text-muted-foreground"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
