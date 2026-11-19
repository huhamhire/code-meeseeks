import { describe, expect, it } from 'vitest';
import { formatCliArgs, parseCliArgs, validCliArgs } from '../src/cli-args.js';
import { LlmProfileSchema } from '../src/config.js';

describe('CLI profile arguments', () => {
  it('groups quotes without shell expansion and preserves Windows paths', () => {
    expect(parseCliArgs('--model "my model"\n-c service_tier=default')).toEqual([
      '--model',
      'my model',
      '-c',
      'service_tier=default',
    ]);
    expect(parseCliArgs(String.raw`'C:\Users\name' '$HOME' $(whoami)`)).toEqual([
      String.raw`C:\Users\name`,
      '$HOME',
      '$(whoami)',
    ]);
    const args = ['--model', 'with "quotes" and \\path', '', "it's"];
    expect(parseCliArgs(formatCliArgs(args))).toEqual(args);
    expect(() => parseCliArgs('--model "unfinished')).toThrow('Unclosed quote');
  });

  it('accepts model and effort overrides in split and equals forms', () => {
    expect(
      validCliArgs('codex', [
        '--model=gpt-6.1-sol',
        '-c',
        'model_reasoning_effort=medium',
        '--config=service_tier=default',
      ]),
    ).toBe(true);
    expect(
      validCliArgs('claude', ['--model', 'sonnet', '--effort=medium', '--max-turns', '3']),
    ).toBe(true);
  });

  it.each([
    ['--json'],
    ['exec'],
    ['-'],
    ['--model'],
    ['--model='],
    ['--sandbox', 'danger-full-access'],
    ['--config', 'sandbox_mode="danger-full-access"'],
    ['-c', 'model_reasoning_effort='],
    ['--model', 'bad\nvalue'],
    ['-c', 'features.image_generation=true'],
    ['--output-format', 'text'],
  ])('rejects protocol changes and invalid argv: %j', (...args) => {
    expect(validCliArgs('codex', args)).toBe(false);
  });

  it('keeps old profiles compatible and validates manually edited configuration', () => {
    expect(
      LlmProfileSchema.parse({ id: 'legacy', provider: 'cli', model: 'codex' }).cli_args,
    ).toBeUndefined();
    expect(
      LlmProfileSchema.safeParse({
        id: 'custom',
        provider: 'cli',
        model: 'codex',
        cli_args: ['--json'],
      }).success,
    ).toBe(false);
    expect(
      LlmProfileSchema.parse({
        id: 'custom',
        provider: 'cli',
        model: 'codex',
        cli_args: ['-m', 'custom-model'],
      }).cli_args,
    ).toEqual(['-m', 'custom-model']);
  });
});
