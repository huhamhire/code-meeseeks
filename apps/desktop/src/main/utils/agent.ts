import type { LlmProfile } from '@meebox/shared';

/** 从 llm config 拿当前选中的 profile；active_id 空或找不到都返回 null。 */
export function resolveActiveLlmProfile(llm: {
  profiles: LlmProfile[];
  active_id: string;
}): LlmProfile | null {
  if (!llm.active_id) return null;
  return llm.profiles.find((p) => p.id === llm.active_id) ?? null;
}
