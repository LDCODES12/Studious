"use client";

import { useState, useCallback, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Dropzone } from "@/components/upload/dropzone";
import { ParsedEventsTable } from "@/components/upload/parsed-events-table";
import { GoogleConnectButton } from "@/components/upload/google-connect-button";
import { extractTextFromPDF } from "@/lib/extract-pdf-text";
import { type SyllabusEvent } from "@/types";

type Stage = "upload" | "parsing" | "review" | "syncing";

function UploadPageInner() {
  const searchParams = useSearchParams();
  const [stage, setStage] = useState<Stage>("upload");
  const [files, setFiles] = useState<File[]>([]);
  const [events, setEvents] = useState<SyllabusEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [topicsByCourse, setTopicsByCourse] = useState<Record<string, unknown[]>>({});

  const googleConnected = searchParams.get("google") === "connected";

  useEffect(() => {
    const saved = sessionStorage.getItem("pendingEvents");
    if (saved) {
      try {
        setEvents(JSON.parse(saved));
        setStage("review");
      } catch {}
    }
    const savedTopics = sessionStorage.getItem("pendingTopicsByCourse");
    if (savedTopics) {
      try {
        setTopicsByCourse(JSON.parse(savedTopics));
      } catch {}
    }
  }, []);

  useEffect(() => {
    const err = searchParams.get("error");
    if (err === "auth_failed") setError("Google Calendar connection failed. Please try again.");
    if (err === "no_code") setError("Google Calendar authorization was cancelled.");
  }, [searchParams]);

  const handleFiles = useCallback((newFiles: File[]) => {
    setFiles(newFiles);
    setError(null);
  }, []);

  const handleParse = async () => {
    if (files.length === 0) return;
    setStage("parsing");
    setError(null);

    try {
      const texts = await Promise.all(files.map(extractTextFromPDF));
      const res = await fetch("/api/syllabus/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error("Server error " + res.status + ": " + (body.error ?? "unknown"));
      }
      const data = await res.json();
      setEvents(data.events);
      setTopicsByCourse(data.topicsByCourse ?? {});
      sessionStorage.setItem("pendingEvents", JSON.stringify(data.events));
      sessionStorage.setItem("pendingTopicsByCourse", JSON.stringify(data.topicsByCourse ?? {}));
      setStage("review");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError("Parse failed: " + msg);
      setStage("upload");
    }
  };

  const handleToggle = (id: string) => {
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, selected: !e.selected } : e)));
  };

  const handleToggleAll = () => {
    const allSelected = events.every((e) => e.selected);
    setEvents((prev) => prev.map((e) => ({ ...e, selected: !allSelected })));
  };

  const handleSync = async () => {
    const selected = events.filter((e) => e.selected);
    if (selected.length === 0) return;
    setStage("syncing");
    setError(null);

    try {
      let calendarResults: { title: string; success: boolean; googleEventId?: string | null }[] = [];
      if (googleConnected) {
        const res = await fetch("/api/calendar/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events: selected }),
        });
        if (res.ok) {
          const data = await res.json();
          calendarResults = data.results;
        }
      }

      const saveRes = await fetch("/api/syllabus/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: selected, syncResults: calendarResults, topicsByCourse }),
      });

      sessionStorage.removeItem("pendingEvents");
      sessionStorage.removeItem("pendingTopicsByCourse");

      const saveData = await saveRes.json();
      const courses: { id: string; name: string }[] = saveData.courses ?? [];
      if (courses.length === 1) {
        window.location.href = "/courses/" + courses[0].id;
      } else {
        window.location.href = "/";
      }
    } catch {
      setError("Failed to save. Please try again.");
      setStage("review");
    }
  };

  const handleReset = () => {
    setFiles([]);
    setEvents([]);
    setTopicsByCourse({});
    setError(null);
    setStage("upload");
    sessionStorage.removeItem("pendingEvents");
    sessionStorage.removeItem("pendingTopicsByCourse");
  };

  const selectedCount = events.filter((e) => e.selected).length;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Upload Syllabus</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Drop your syllabus PDFs to extract deadlines and weekly content.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {(stage === "upload" || stage === "parsing") && (
        <div className="space-y-4">
          <Dropzone onFiles={handleFiles} disabled={stage === "parsing"} />
          {files.length > 0 && (
            <div className="space-y-3">
              <div className="text-[13px] text-muted-foreground">
                {files.length} file{files.length > 1 ? "s" : ""} selected
              </div>
              <div className="space-y-1">
                {files.map((f, i) => (
                  <div key={i} className="text-[13px]">{f.name}</div>
                ))}
              </div>
              <button
                onClick={handleParse}
                disabled={stage === "parsing"}
                className="rounded-md bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {stage === "parsing" ? "Parsing — this takes 15–30 seconds..." : "Parse Syllabus"}
              </button>
            </div>
          )}
        </div>
      )}

      {(stage === "review" || stage === "syncing") && events.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-[13px] text-muted-foreground">
              {events.length} event{events.length > 1 ? "s" : ""} found — {selectedCount} selected
            </p>
            <button
              onClick={handleReset}
              className="text-[12px] text-muted-foreground hover:text-foreground"
            >
              Start over
            </button>
          </div>
          <ParsedEventsTable events={events} onToggle={handleToggle} onToggleAll={handleToggleAll} />
          <div className="flex items-center justify-between">
            <GoogleConnectButton connected={googleConnected} />
            <button
              onClick={handleSync}
              disabled={stage === "syncing" || selectedCount === 0}
              className="rounded-md bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {stage === "syncing"
                ? "Saving..."
                : googleConnected
                ? "Save " + selectedCount + " to Study Circle + Calendar"
                : "Save " + selectedCount + " to Study Circle"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function UploadPage() {
  return (
    <Suspense>
      <UploadPageInner />
    </Suspense>
  );
}
