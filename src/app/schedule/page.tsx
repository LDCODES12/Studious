import { ScheduleView } from "@/components/schedule/schedule-view";

export default function SchedulePage() {
  return (
    <div className="mx-auto max-w-[1200px]">
      <h1 className="mb-6 text-lg font-semibold">Schedule</h1>
      <ScheduleView />
    </div>
  );
}
