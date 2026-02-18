"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut, useSession } from "next-auth/react";
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

export function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [courses, setCourses] = useState<Course[]>([]);

  useEffect(() => {
    fetch("/api/courses")
      .then((r) => r.json())
      .then((data) => setCourses(data.courses ?? []))
      .catch(() => {});
  }, [pathname]);

  const userName = session?.user?.name ?? "Student";
  const userInitial = userName.charAt(0).toUpperCase();

  return (
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
              return (
                <Link
                  key={course.id}
                  href={`/courses/${course.id}`}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] transition-colors",
                    isActive
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      colors?.dot ?? "bg-gray-400"
                    )}
                  />
                  {course.shortName ?? course.name}
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
  );
}
