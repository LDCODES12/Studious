import { Sparkles } from "lucide-react";
import type { InterventionSummary } from "@/lib/intervention-outcomes";

interface Props {
  outcomes: InterventionSummary;
}

export function WhatsWorking({ outcomes }: Props) {
  const insights = outcomes.outcomes
    .filter((o) => o.insight !== null)
    .map((o) => o.insight!);

  if (insights.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card px-5 py-3.5">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-purple-500" />
        <p className="text-[12px] font-medium text-muted-foreground">
          What&apos;s working
        </p>
      </div>
      <p className="mt-1 text-[13px]">{insights[0]}</p>
      {insights.length > 1 && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          +{insights.length - 1} more insight{insights.length > 2 ? "s" : ""}
        </p>
      )}
    </div>
  );
}
