import { NextRequest, NextResponse } from "next/server";

type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  route: string;
  userId?: string;
  duration?: number;
  status?: number;
  error?: string;
  [key: string]: unknown;
}

function emit(entry: LogEntry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  if (entry.level === "error") {
    console.error(line);
  } else if (entry.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Structured logger for API routes. Logs request start (in dev), and always
 * logs the outcome (status, duration, extras) as a single JSON line that
 * Vercel's log viewer can parse and filter.
 *
 * Usage:
 *   const log = apiLogger("POST /api/canvas/import", userId);
 *   log.info("starting sync", { courses: 5 });
 *   log.error("sync failed", { error: err.message });
 *   return log.respond(NextResponse.json(result), { gsUpdated: 3 });
 */
export function apiLogger(route: string, userId?: string | null) {
  const t0 = Date.now();
  const ctx = { route, userId: userId ?? undefined };

  return {
    info(message: string, extra?: Record<string, unknown>) {
      emit({ level: "info", ...ctx, message, ...extra });
    },

    warn(message: string, extra?: Record<string, unknown>) {
      emit({ level: "warn", ...ctx, message, ...extra });
    },

    error(message: string, extra?: Record<string, unknown>) {
      emit({ level: "error", ...ctx, message, ...extra });
    },

    /**
     * Wrap a NextResponse before returning it. Emits a summary log line with
     * status, duration, and any extra fields you want to record.
     */
    respond(res: NextResponse | Response, extra?: Record<string, unknown>) {
      emit({
        level: res.status >= 400 ? "error" : "info",
        ...ctx,
        status: res.status,
        duration: Date.now() - t0,
        ...extra,
      });
      return res;
    },
  };
}

/**
 * Quick helper when you just need to identify the user from a bearer token
 * without importing the full auth module (avoids circular deps in some routes).
 */
export function bearerToken(request: NextRequest): string | null {
  const h = request.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}
