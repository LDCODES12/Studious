/**
 * Centralized AI model configuration.
 *
 * Single source of truth for model name and reasoning effort.
 * Every AI call in the codebase imports from here.
 */

import { openai } from "@ai-sdk/openai";

export type ReasoningTier = "low" | "medium" | "high" | "max";

/**
 * Returns model + providerOptions ready to spread into
 * generateObject / streamText calls:
 *
 *   generateObject({ ...modelConfig("medium"), schema, system, prompt })
 *
 * "max" tier uses gpt-5.4-mini with high reasoning — for complex tasks
 * that need more power than nano can provide (e.g. reconciling multiple
 * data sources like syllabus + module context).
 */
export function modelConfig(tier: ReasoningTier) {
  if (tier === "max") {
    return {
      model: openai("gpt-5.4-mini"),
      providerOptions: {
        openai: { reasoningEffort: "high" as const, store: true },
      },
    };
  }
  return {
    model: openai("gpt-5.4-nano"),
    providerOptions: {
      openai: { reasoningEffort: tier, store: true },
    },
  };
}
