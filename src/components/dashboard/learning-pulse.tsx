import type { LearningSignals } from "@/lib/learning-signals";

interface Props {
  signals: LearningSignals;
}

export function LearningPulse({ signals }: Props) {
  const { confidenceTrend, studyStreak, onTimeRate } = signals;

  const nudges: { text: string; tone: "positive" | "warning" | "neutral" }[] = [];

  // Confidence declining
  if (confidenceTrend.direction === "declining") {
    nudges.push({
      text: "Your confidence has been dropping — consider reviewing recent material",
      tone: "warning",
    });
  }

  // Study streak
  if (studyStreak >= 3) {
    nudges.push({
      text: `${studyStreak}-day study streak — keep it going`,
      tone: "positive",
    });
  }

  // On-time rate declining
  if (onTimeRate && onTimeRate.rate < 0.7 && onTimeRate.total >= 3) {
    const missed = onTimeRate.total - onTimeRate.onTime;
    nudges.push({
      text: `${missed} late submissions recently — try starting assignments earlier`,
      tone: "warning",
    });
  }

  // Confidence improving
  if (confidenceTrend.direction === "improving") {
    nudges.push({
      text: "Your confidence is trending up — nice work",
      tone: "positive",
    });
  }

  if (nudges.length === 0) return null;

  const toneStyles = {
    positive: "text-green-600",
    warning: "text-amber-600",
    neutral: "text-muted-foreground",
  };

  return (
    <div className="space-y-1.5">
      {nudges.slice(0, 2).map((nudge) => (
        <p key={nudge.text} className={`text-[13px] ${toneStyles[nudge.tone]}`}>
          {nudge.text}
        </p>
      ))}
    </div>
  );
}
