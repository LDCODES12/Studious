export const HOURS = Array.from({ length: 24 }, (_, i) => i);
export const HOUR_HEIGHT = 64;
export const GUTTER_WIDTH = 56;
export const SNAP_MINUTES = 15;
export const MIN_EVENT_DURATION_MIN = 15;
export const TOTAL_GRID_HEIGHT = HOURS.length * HOUR_HEIGHT;
export const DAY_COUNT = 7;

export const ACCENT_DOT: Record<string, string> = {
  blue: "bg-blue-500",
  green: "bg-green-500",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
  rose: "bg-rose-500",
};

export const ACCENT_CHIP: Record<string, string> = {
  blue: "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  green: "bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-300",
  purple: "bg-purple-50 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300",
  orange: "bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
  rose: "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
};

export const ACCENT_BAR: Record<string, string> = {
  blue: "bg-blue-500",
  green: "bg-green-500",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
  rose: "bg-rose-500",
};

export const ACCENT_EVENT_BG: Record<string, string> = {
  blue: "bg-blue-500/10 hover:bg-blue-500/[0.15] dark:bg-blue-400/15 dark:hover:bg-blue-400/20",
  green: "bg-green-500/10 hover:bg-green-500/[0.15] dark:bg-green-400/15 dark:hover:bg-green-400/20",
  purple: "bg-purple-500/10 hover:bg-purple-500/[0.15] dark:bg-purple-400/15 dark:hover:bg-purple-400/20",
  orange: "bg-orange-500/10 hover:bg-orange-500/[0.15] dark:bg-orange-400/15 dark:hover:bg-orange-400/20",
  rose: "bg-rose-500/10 hover:bg-rose-500/[0.15] dark:bg-rose-400/15 dark:hover:bg-rose-400/20",
};

export const ACCENT_EVENT_TEXT: Record<string, string> = {
  blue: "text-blue-700 dark:text-blue-300",
  green: "text-green-700 dark:text-green-300",
  purple: "text-purple-700 dark:text-purple-300",
  orange: "text-orange-700 dark:text-orange-300",
  rose: "text-rose-700 dark:text-rose-300",
};

export const ACCENT_EVENT_BORDER: Record<string, string> = {
  blue: "border-l-blue-500",
  green: "border-l-green-500",
  purple: "border-l-purple-500",
  orange: "border-l-orange-500",
  rose: "border-l-rose-500",
};

export const DEFAULT_EVENT_COLOR = "blue";
