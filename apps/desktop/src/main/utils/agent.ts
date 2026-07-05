import type { LlmProfile } from '@meebox/shared';

/** Get the currently selected profile from llm config; returns null when active_id is empty or not found. */
export function resolveActiveLlmProfile(llm: {
  profiles: LlmProfile[];
  active_id: string;
}): LlmProfile | null {
  if (!llm.active_id) return null;
  return llm.profiles.find((p) => p.id === llm.active_id) ?? null;
}
