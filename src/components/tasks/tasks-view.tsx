"use client";

import { useState } from "react";
import { isToday, isFuture, parseISO } from "date-fns";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TaskItem, type TaskData } from "./task-item";
import { CreateTaskForm } from "./create-task-form";

interface CourseOption {
  id: string;
  name: string;
  shortName: string | null;
  color: string;
}

interface TasksViewProps {
  initialTasks: TaskData[];
  courses: CourseOption[];
  googleConnected: boolean;
}

export function TasksView({ initialTasks, courses, googleConnected }: TasksViewProps) {
  const [tasks, setTasks] = useState<TaskData[]>(initialTasks);
  const [courseFilter, setCourseFilter] = useState("");

  const handleToggle = async (id: string, completed: boolean) => {
    // Optimistic update
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, completed } : t))
    );
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed }),
      });
      if (!res.ok) {
        // Revert on failure
        setTasks((prev) =>
          prev.map((t) => (t.id === id ? { ...t, completed: !completed } : t))
        );
      }
    } catch {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, completed: !completed } : t))
      );
    }
  };

  const handleDelete = async (id: string) => {
    const prev = tasks;
    setTasks((t) => t.filter((task) => task.id !== id));
    try {
      const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      if (!res.ok) setTasks(prev);
    } catch {
      setTasks(prev);
    }
  };

  const handleCalendarSync = async (id: string) => {
    const res = await fetch(`/api/tasks/${id}/calendar-sync`, { method: "POST" });
    if (res.ok) {
      const { googleEventId } = await res.json();
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, googleEventId } : t))
      );
    }
  };

  const handleCreated = (task: TaskData) => {
    setTasks((prev) => [task, ...prev]);
  };

  // Filter by course
  const filtered = courseFilter
    ? tasks.filter((t) => t.course?.id === courseFilter)
    : tasks;

  // Tab filters
  const todayTasks = filtered.filter(
    (t) => !t.completed && t.dueDate && isToday(parseISO(t.dueDate))
  );
  const upcomingTasks = filtered.filter(
    (t) => !t.completed && t.dueDate && isFuture(parseISO(t.dueDate))
  );
  const allPending = filtered.filter((t) => !t.completed);
  const completedTasks = filtered.filter((t) => t.completed);

  const renderList = (items: TaskData[], emptyMessage: string) => {
    if (items.length === 0) {
      return (
        <div className="rounded-lg border border-border bg-card px-6 py-10 text-center">
          <p className="text-[13px] text-muted-foreground">{emptyMessage}</p>
        </div>
      );
    }
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-card divide-y divide-border">
        {items.map((task) => (
          <TaskItem
            key={task.id}
            task={task}
            onToggle={handleToggle}
            onDelete={handleDelete}
            onCalendarSync={handleCalendarSync}
            googleConnected={googleConnected}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <CreateTaskForm courses={courses} onCreated={handleCreated} />

      {/* Course filter */}
      {courses.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">Filter:</span>
          <select
            value={courseFilter}
            onChange={(e) => setCourseFilter(e.target.value)}
            className="h-7 rounded border border-border bg-transparent px-2 text-[12px] text-muted-foreground"
          >
            <option value="">All courses</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.shortName ?? c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <Tabs defaultValue="all">
        <TabsList className="mb-4">
          <TabsTrigger value="today">
            Today{todayTasks.length > 0 && ` (${todayTasks.length})`}
          </TabsTrigger>
          <TabsTrigger value="upcoming">
            Upcoming{upcomingTasks.length > 0 && ` (${upcomingTasks.length})`}
          </TabsTrigger>
          <TabsTrigger value="all">
            All{allPending.length > 0 && ` (${allPending.length})`}
          </TabsTrigger>
          <TabsTrigger value="completed">
            Completed{completedTasks.length > 0 && ` (${completedTasks.length})`}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="today">
          {renderList(todayTasks, "No tasks due today. Looking good!")}
        </TabsContent>

        <TabsContent value="upcoming">
          {renderList(upcomingTasks, "No upcoming tasks.")}
        </TabsContent>

        <TabsContent value="all">
          {renderList(allPending, "No pending tasks. Create one above!")}
        </TabsContent>

        <TabsContent value="completed">
          {renderList(completedTasks, "No completed tasks yet.")}
        </TabsContent>
      </Tabs>
    </div>
  );
}
