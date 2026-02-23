import { ScheduleView } from "@/components/schedule/schedule-view";

export default function SchedulePage() {
  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Schedule</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Your assignments and calendar in one place
        </p>
      </div>
      <ScheduleView />
    </div>
  );
}
