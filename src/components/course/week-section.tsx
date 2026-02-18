"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { AssignmentRow } from "./assignment-row";
import { MaterialChip } from "./material-chip";
import { type Assignment, type Material } from "@/types";

interface WeekSectionProps {
  weekNumber: number;
  label: string;
  assignments: Assignment[];
  materials: Material[];
  defaultOpen?: boolean;
}

export function WeekSection({
  weekNumber,
  label,
  assignments,
  materials,
  defaultOpen = false,
}: WeekSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-accent/30"
      >
        <ChevronRight
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="text-[13px] font-medium">
          Week {weekNumber}
        </span>
        <span className="text-[13px] text-muted-foreground">· {label}</span>
      </button>

      {open && (
        <div className="border-t border-border px-4 py-4">
          {materials.length > 0 && (
            <div className="mb-4">
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                Materials
              </p>
              <div className="space-y-1">
                {materials.map((m) => (
                  <MaterialChip key={m.id} material={m} />
                ))}
              </div>
            </div>
          )}

          {assignments.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                Assignments
              </p>
              {assignments.map((a) => (
                <AssignmentRow key={a.id} assignment={a} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
