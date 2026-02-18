"use client";

import { useRef, useState } from "react";

export interface UploadedMaterial {
  id: string;
  courseId: string;
  fileName: string;
  detectedType: string;
  summary: string;
  relatedTopics: string[];
  uploadedAt: string;
}

interface MaterialUploaderProps {
  courseId: string;
  onUploadComplete: (material: UploadedMaterial) => void;
}

export function MaterialUploader({ courseId, onUploadComplete }: MaterialUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`/api/courses/${courseId}/materials`, {
        method: "POST",
        body: formData,
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
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

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
        disabled={uploading}
        className="rounded-md border border-border px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
      >
        {uploading ? "Analyzing..." : "Upload PDF"}
      </button>
      {error && <p className="text-[12px] text-red-600">{error}</p>}
    </div>
  );
}
