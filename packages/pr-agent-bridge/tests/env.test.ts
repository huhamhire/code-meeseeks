import { describe, expect, it } from 'vitest';
import { LlmProfileSchema } from '@meebox/shared';
import { buildChatEnv, buildToolEnv } from '../src/env.js';

describe('CLI argument transport', () => {
  it('uses the same JSON argv for every PR tool and orchestration chat', () => {
    const profile = LlmProfileSchema.parse({
      id: 'cli',
      provider: 'cli',
      model: 'codex',
      cli_args: ['--model', 'custom model', '-c', 'model_reasoning_effort=medium'],
    });
    for (const tool of ['describe', 'review', 'ask', 'improve'] as const) {
      expect(JSON.parse(buildToolEnv(profile, { tool }).MEEBOX_CLI_ARGS!)).toEqual(
        profile.cli_args,
      );
    }
    const env = buildChatEnv(profile, { lowReasoning: true });
    expect(JSON.parse(env.MEEBOX_CLI_ARGS!)).toEqual(profile.cli_args);
    expect(env.MEEBOX_CLI_REASONING).toBe('low');
    expect(env.MEEBOX_CLI_BIN).toBe('codex');
  });

  it('clears inherited CLI arguments for legacy profiles', () => {
    const profile = LlmProfileSchema.parse({ id: 'legacy', provider: 'cli', model: 'codex' });
    expect(buildChatEnv(profile).MEEBOX_CLI_ARGS).toBe('[]');
  });
});
