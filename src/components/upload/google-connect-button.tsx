"use client";

interface GoogleConnectButtonProps {
  connected: boolean;
}

export function GoogleConnectButton({ connected }: GoogleConnectButtonProps) {
  if (connected) {
    return (
      <div className="flex items-center gap-2 text-[13px]">
        <span className="h-2 w-2 rounded-full bg-green-500" />
        <span className="text-muted-foreground">Google Calendar connected</span>
      </div>
    );
  }

  return (
    <a
      href="/api/auth/google"
      className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-[13px] font-medium transition-colors hover:bg-accent"
    >
      Connect Google Calendar
    </a>
  );
}
