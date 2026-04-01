export type SimpleRequestUIPart = { type: "text"; text: string };
export type SimpleRequestUIMessage = {
  role: "system" | "user" | "assistant";
  parts: SimpleRequestUIPart[];
};

export function sanitizeUiMessages(input: unknown): SimpleRequestUIMessage[] {
  if (!Array.isArray(input)) return [];

  return input.flatMap((message) => {
    if (!message || typeof message !== "object") return [];

    const role = "role" in message ? message.role : undefined;
    if (role !== "system" && role !== "user" && role !== "assistant") return [];

    const rawParts = "parts" in message ? message.parts : undefined;
    const parts = Array.isArray(rawParts)
      ? rawParts.flatMap((part) => {
          if (!part || typeof part !== "object") return [];
          if (!("type" in part) || part.type !== "text") return [];
          if (!("text" in part) || typeof part.text !== "string") return [];
          return [{ type: "text" as const, text: part.text }];
        })
      : [];

    return [{ role, parts }];
  });
}

export function extractTextFromParts(parts: SimpleRequestUIPart[] | undefined): string {
  return (parts ?? []).map((part) => part.text).join("");
}
