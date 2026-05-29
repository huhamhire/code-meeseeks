import { z } from 'zod';

export const BitbucketServerConnectionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('bitbucket-server'),
  base_url: z.string().url(),
  display_name: z.string(),
  auth: z.object({
    type: z.literal('pat'),
    token: z.string(),
  }),
});

export const ConnectionSchema = z.discriminatedUnion('kind', [BitbucketServerConnectionSchema]);

export const ConfigSchema = z.object({
  workspace: z
    .object({
      repos_dir: z.string().default('~/.pr-pilot/repos'),
    })
    .default({}),
  poller: z
    .object({
      interval_seconds: z.number().int().min(30).default(300),
    })
    .default({}),
  connections: z.array(ConnectionSchema).default([]),
  llm: z
    .object({
      provider: z.string().default('openai-compatible'),
      base_url: z.string().default(''),
      model: z.string().default(''),
      api_key: z.string().default(''),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type BitbucketServerConnection = z.infer<typeof BitbucketServerConnectionSchema>;
