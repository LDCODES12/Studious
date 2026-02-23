import { ScheduleView } from "@/components/schedule/schedule-view";

export default function SchedulePage() {
  return (
    <div className="mx-auto flex max-w-[1400px] flex-1 flex-col gap-5" style={{ minHeight: 0 }}>
      <div className="shrink-0">
        <h1 className="text-lg font-medium">Schedule</h1>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          Assignments and calendar
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <ScheduleView />
      </div>
    </div>
  );
}
