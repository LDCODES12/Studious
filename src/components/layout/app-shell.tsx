"use client";

import { SessionProvider } from "next-auth/react";
import { Sidebar } from "./sidebar";
import { Header } from "./header";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <div className="flex h-screen bg-background">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header />
          <main className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5">{children}</main>
        </div>
      </div>
    </SessionProvider>
  );
}
