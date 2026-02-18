"use client";

import { format } from "date-fns";
function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function GreetingBanner({ name }: { name: string }) {
  const today = format(new Date(), "EEEE, MMMM d");

  return (
    <div>
      <p className="text-[13px] text-muted-foreground">{today}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">
        {getGreeting()}, {name}
      </h1>
    </div>
  );
}
