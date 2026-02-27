import type { LearningSignals } from "@/lib/learning-signals";

interface Props {
  signals: LearningSignals;
}

const TREND_CONFIG = {
  improving:    { label: "Improving",       className: "text-green-600" },
  declining:    { label: "Needs attention", className: "text-red-600" },
  stable:       { label: "Stable",          className: "text-blue-600" },
  insufficient: { label: "Building...",     className: "text-muted-foreground" },
} as const;

export function LearningPulse({ signals }: Props) {
  const { confidenceTrend, studyStreak, activeDaysLast7, taskCompletion, onTimeRate, planFollowThrough } = signals;

  const trend = TREND_CONFIG[confidenceTrend.direction];

  return (
    <div className="grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-border bg-border">
      {/* Confidence Trend */}
      <div className="bg-card px-5 py-4">
        <p className="text-[12px] text-muted-foreground">Confidence</p>
        <p className={`mt-1 text-lg font-semibold ${trend.className}`}>
          {trend.label}
        </p>
        {confidenceTrend.direction !== "insufficient" && (
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {confidenceTrend.recentAvg.toFixed(1)}/3 avg
          </p>
        )}
      </div>

      {/* Study Streak */}
      <div className="bg-card px-5 py-4">
        <p className="text-[12px] text-muted-foreground">Streak</p>
        <p className="mt-1 text-lg font-semibold tabular-nums">
          {studyStreak > 0 ? `${studyStreak}d` : "—"}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {activeDaysLast7}/7 active days
        </p>
      </div>

      {/* Task Completion (30d) */}
      <div className="bg-card px-5 py-4">
        <p className="text-[12px] text-muted-foreground">Tasks (30d)</p>
        {taskCompletion ? (
          <>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              {taskCompletion.done}/{taskCompletion.total}
            </p>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-green-500"
                style={{ width: `${Math.round(taskCompletion.rate * 100)}%` }}
              />
            </div>
          </>
        ) : (
          <p className="mt-1 text-lg font-semibold">—</p>
        )}
      </div>

      {/* 4th cell: Plan follow-through (if data exists) or On-time rate */}
      {planFollowThrough ? (
        <div className="bg-card px-5 py-4">
          <p className="text-[12px] text-muted-foreground">Plan tasks</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {planFollowThrough.completed}/{planFollowThrough.created}
          </p>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-purple-500"
              style={{ width: `${Math.round(planFollowThrough.rate * 100)}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="bg-card px-5 py-4">
          <p className="text-[12px] text-muted-foreground">On time</p>
          {onTimeRate ? (
            <>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {Math.round(onTimeRate.rate * 100)}%
              </p>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
                <div
                  className="h-full rounded-full bg-blue-500"
                  style={{ width: `${Math.round(onTimeRate.rate * 100)}%` }}
                />
              </div>
            </>
          ) : (
            <p className="mt-1 text-lg font-semibold">—</p>
          )}
        </div>
      )}
    </div>
  );
}
