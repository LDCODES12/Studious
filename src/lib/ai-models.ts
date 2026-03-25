/**
 * Centralized AI model configuration.
 *
 * Single source of truth for model name and reasoning effort.
 * Every AI call in the codebase imports from here.
 */

import { openai } from "@ai-sdk/openai";

export type ReasoningTier = "low" | "medium" | "high";

/**
 * Returns model + providerOptions ready to spread into
 * generateObject / streamText calls:
 *
 *   generateObject({ ...modelConfig("medium"), schema, system, prompt })
 */
export function modelConfig(tier: ReasoningTier) {
  return {
    model: openai("gpt-5.4-nano"),
    providerOptions: {
      openai: { reasoningEffort: tier, store: true },
    },
  };
}
