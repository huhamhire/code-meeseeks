import { describe, expect, it } from 'vitest';
import { ConfigSchema, GITHUB_DOTCOM_API_BASE } from '../src/config.js';

describe('ConfigSchema', () => {
  it('fills nested settings for a new install and a partial saved configuration', () => {
    const defaults = ConfigSchema.parse({});
    expect(defaults).toMatchObject({
      appearance: { editor_theme: 'auto' },
      agent: {
        autopilot: { enabled: false, grants: [] },
        strategy: { auto_followup: true, max_followup_asks: 2 },
      },
      proxy: { enabled: false, port: 8080 },
      service: { enabled: false, port: 18765 },
      llm: { profiles: [], active_id: '', context_tokens: 128000 },
    });
    expect(ConfigSchema.parse({ agent: { autopilot: { enabled: true } } })).toEqual({
      ...defaults,
      agent: { ...defaults.agent, autopilot: { ...defaults.agent.autopilot, enabled: true } },
    });
  });

  it('continues migrating legacy LLM profiles and filling connection defaults', () => {
    const result = ConfigSchema.parse({
      connections: [
        { id: 'github', kind: 'github', display_name: 'GitHub', auth: { type: 'pat', token: '' } },
      ],
      llm: { provider: 'ollama', model: 'local-model' },
    });
    expect(result.connections[0]).toMatchObject({
      base_url: GITHUB_DOTCOM_API_BASE,
      clone: { protocol: 'pat' },
    });
    expect(result.llm).toMatchObject({
      active_id: 'default',
      profiles: [
        {
          id: 'default',
          provider: 'openai-compatible',
          base_url: 'http://localhost:11434/v1',
          model: 'local-model',
        },
      ],
    });
  });
});
