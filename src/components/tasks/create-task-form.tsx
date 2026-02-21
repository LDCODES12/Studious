"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import type { TaskData } from "./task-item";

interface CourseOption {
  id: string;
  name: string;
  shortName: string | null;
  color: string;
}

interface CreateTaskFormProps {
  courses: CourseOption[];
  onCreated: (task: TaskData) => void;
}

export function CreateTaskForm({ courses, onCreated }: CreateTaskFormProps) {
  const [title, setTitle] = useState("");
  const [courseId, setCourseId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState("medium");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || saving) return;

    setSaving(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          courseId: courseId || null,
          dueDate: dueDate || null,
          priority,
        }),
      });
      if (res.ok) {
        const { task } = await res.json();
        onCreated(task);
        setTitle("");
        setDueDate("");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-card p-3">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add a task..."
        className="w-full bg-transparent text-[13px] placeholder:text-muted-foreground/60 focus:outline-none"
      />
      <div className="mt-2 flex items-center gap-2">
        <select
          value={courseId}
          onChange={(e) => setCourseId(e.target.value)}
          className="h-7 rounded border border-border bg-transparent px-2 text-[12px] text-muted-foreground"
        >
          <option value="">No course</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.shortName ?? c.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className="h-7 rounded border border-border bg-transparent px-2 text-[12px] text-muted-foreground"
        />
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          className="h-7 rounded border border-border bg-transparent px-2 text-[12px] text-muted-foreground"
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <button
          type="submit"
          disabled={!title.trim() || saving}
          className="ml-auto flex h-7 items-center gap-1 rounded bg-foreground px-3 text-[12px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </div>
    </form>
  );
}
