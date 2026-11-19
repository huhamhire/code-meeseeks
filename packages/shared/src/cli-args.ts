/** Parse argument text without shell expansion. Quotes group text; backslashes in paths stay literal. */
export function parseCliArgs(text: string): string[] {
  const args: string[] = [];
  let token = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (
      c === '\\' &&
      (text[i + 1] === quote ||
        text[i + 1] === '\\' ||
        (!quote && /[\s"']/.test(text[i + 1] ?? '')))
    ) {
      token += text[++i];
      started = true;
    } else if (quote) {
      if (c === quote) quote = '';
      else token += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) args.push(token);
      token = '';
      started = false;
    } else {
      token += c;
      started = true;
    }
  }
  if (quote) throw new Error('Unclosed quote in CLI arguments');
  if (started) args.push(token);
  return args;
}

export function formatCliArgs(args: readonly string[]): string {
  return args.map((arg) => (/[\s"'\\]/.test(arg) || !arg ? JSON.stringify(arg) : arg)).join(' ');
}

// Keep in sync with the Python shim's cli/args.py. Only value options are accepted; application-owned protocol flags stay fixed.
const VALUE_OPTIONS: Record<string, readonly string[]> = {
  codex: ['--model', '-m', '--config', '-c'],
  claude: ['--model', '--effort', '--max-turns', '--max-budget-usd', '--fallback-model'],
};
const CONFIG_KEYS = ['model', 'model_reasoning_effort', 'service_tier', 'model_verbosity'];

/** Return false for positional prompts, subcommands, unknown options, or application-managed flags. */
export function validCliArgs(command: string, args: readonly string[]): boolean {
  if (!args.length) return true;
  const options = VALUE_OPTIONS[command.trim().toLowerCase()];
  if (!options) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const equals = arg.indexOf('=');
    const option = equals < 0 ? arg : arg.slice(0, equals);
    if (!options.includes(option)) return false;
    const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
    if (!value || value.startsWith('-') || /[\0\r\n]/.test(value)) return false;
    if (
      (option === '-c' || option === '--config') &&
      (!CONFIG_KEYS.includes(value.split('=')[0]!.trim()) ||
        !value.includes('=') ||
        !value.split('=').slice(1).join('=').trim())
    )
      return false;
  }
  return true;
}
