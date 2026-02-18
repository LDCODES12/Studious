"use client";

import { useCallback, useState } from "react";
import { Upload } from "lucide-react";

interface DropzoneProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

export function Dropzone({ onFiles, disabled }: DropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (disabled) return;

      const files = Array.from(e.dataTransfer.files).filter(
        (f) => f.type === "application/pdf"
      );
      if (files.length > 0) onFiles(files);
    },
    [onFiles, disabled]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) onFiles(files);
      e.target.value = "";
    },
    [onFiles]
  );

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-16 transition-colors ${
        isDragging
          ? "border-foreground/30 bg-accent/50"
          : "border-border hover:border-foreground/20 hover:bg-accent/30"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <Upload className="mb-3 h-5 w-5 text-muted-foreground" />
      <p className="text-[13px] font-medium">Drop syllabus PDFs here</p>
      <p className="mt-1 text-[12px] text-muted-foreground">
        or click to browse
      </p>
      <input
        type="file"
        accept=".pdf"
        multiple
        onChange={handleChange}
        className="hidden"
        disabled={disabled}
      />
    </label>
  );
}
