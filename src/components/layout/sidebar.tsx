"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { Trash2 } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { SidebarNavItem } from "./sidebar-nav-item";
import { mainNavItems, courseColors } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface Course {
  id: string;
  name: string;
  shortName: string | null;
  color: string;
}

interface ContextMenu {
  x: number;
  y: number;
  course: Course;
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const [courses, setCourses] = useState<Course[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/courses")
      .then((r) => r.json())
      .then((data) => setCourses(data.courses ?? []))
      .catch(() => {});
  }, [pathname]);

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && menuRef.current?.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent, course: Course) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, course });
  };

  const handleDelete = async (course: Course) => {
    setContextMenu(null);
    setDeleting(course.id);
    try {
      await fetch(`/api/courses/${course.id}`, { method: "DELETE" });
      setCourses((prev) => prev.filter((c) => c.id !== course.id));
      if (pathname === `/courses/${course.id}`) router.push("/");
    } finally {
      setDeleting(null);
    }
  };

  const userName = session?.user?.name ?? "Student";
  const userInitial = userName.charAt(0).toUpperCase();

  return (
    <>
      <aside className="flex h-screen w-[240px] flex-col border-r border-border bg-sidebar">
        {/* Logo */}
        <div className="px-5 py-5">
          <span className="text-[15px] font-semibold tracking-tight">Study Circle</span>
        </div>

        <Separator />

        {/* Main nav */}
        <nav className="flex flex-col gap-0.5 px-3 py-3">
          {mainNavItems.map((item) => (
            <SidebarNavItem key={item.href} {...item} />
          ))}
        </nav>

        <Separator />

        {/* Courses */}
        <div className="flex flex-1 flex-col overflow-y-auto px-3 py-3">
          <p className="mb-2 px-2.5 text-[11px] font-medium text-muted-foreground">
            Courses
          </p>
          <div className="flex flex-col gap-0.5">
            {courses.length === 0 ? (
              <p className="px-2.5 text-[12px] text-muted-foreground">
                Upload a syllabus to add courses.
              </p>
            ) : (
              courses.map((course) => {
                const colors = courseColors[course.color];
                const isActive = pathname === `/courses/${course.id}`;
                const isDeleting = deleting === course.id;
                return (
                  <Link
                    key={course.id}
                    href={`/courses/${course.id}`}
                    onContextMenu={(e) => handleContextMenu(e, course)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] transition-colors",
                      isActive
                        ? "bg-accent font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                      isDeleting && "opacity-40 pointer-events-none"
                    )}
                  >
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full shrink-0",
                        colors?.dot ?? "bg-gray-400"
                      )}
                    />
                    <span className="truncate">
                      {course.shortName ?? course.name}
                    </span>
                  </Link>
                );
              })
            )}
          </div>
        </div>

        <Separator />

        {/* User */}
        <div className="flex items-center gap-2.5 px-5 py-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-foreground text-[11px] font-medium text-background">
            {userInitial}
          </div>
          <div className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{userName}</span>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
            title="Sign out"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-md"
        >
          <button
            onClick={() => handleDelete(contextMenu.course)}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-red-600 hover:bg-red-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete course
          </button>
        </div>
      )}
    </>
  );
}
