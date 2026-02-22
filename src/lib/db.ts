import { PrismaClient } from "@prisma/client";

const SLOW_QUERY_MS = 200;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient<{ log: { emit: "event"; level: "query" }[] }>;
};

function createClient() {
  const isDev = process.env.NODE_ENV === "development";

  const client = new PrismaClient({
    log: isDev
      ? [
          { emit: "event", level: "query" },
          { emit: "stdout", level: "error" },
        ]
      : [{ emit: "stdout", level: "error" }],
  });

  if (isDev) {
    client.$on("query", (e) => {
      if (e.duration >= SLOW_QUERY_MS) {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            type: "slow_query",
            duration: e.duration,
            query: e.query,
          }),
        );
      }
    });
  }

  return client;
}

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production")
  globalForPrisma.prisma = db as typeof globalForPrisma.prisma;
