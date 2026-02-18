"use client";

import { Search } from "lucide-react";

export function Header() {
  return (
    <header className="flex h-12 items-center justify-end border-b border-border px-6">
      <div className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search..."
          className="w-48 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
        />
      </div>
    </header>
  );
}
