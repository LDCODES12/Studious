"use client";

import { useRef, useState } from "react";
import { extractTextFromPDF } from "@/lib/extract-pdf-text";

export interface UploadedMaterial {
  id: string;
  courseId: string;
  fileName: string;
  detectedType: string;
  summary: string;
  relatedTopics: string[];
  storedForAI: boolean;
  uploadedAt: string;
}

interface MaterialUploaderProps {
  courseId: string;
  onUploadComplete: (material: UploadedMaterial) => void;
}

export function MaterialUploader({ courseId, onUploadComplete }: MaterialUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"idle" | "extracting" | "analyzing">("idle");
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setStatus("extracting");
    setError(null);

    try {
      // Extract text client-side using pdfjs-dist — no server-side PDF work needed
      const text = await extractTextFromPDF(file);

      setStatus("analyzing");

      const res = await fetch(`/api/courses/${courseId}/materials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, text }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Upload failed");
      }

      const material = await res.json();
      onUploadComplete(material);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setStatus("idle");
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const label =
    status === "extracting" ? "Extracting…"
    : status === "analyzing" ? "Analyzing…"
    : "Upload PDF";

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={inputRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={status !== "idle"}
        className="rounded-md border border-border px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
      >
        {label}
      </button>
      {error && <p className="text-[12px] text-red-600">{error}</p>}
    </div>
  );
}
