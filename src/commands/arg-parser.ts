export interface ParsedArgs {
  readonly positional: readonly string[];
  readonly options: ReadonlyMap<string, string>;
}

const LONG_PREFIX = "--";

export function parseArgs(args: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const token: string | undefined = args[index];
    if (!token) {
      continue;
    }

    if (!token.startsWith(LONG_PREFIX)) {
      positional.push(token);
      continue;
    }

    const key = token.slice(LONG_PREFIX.length);
    const value = args[index + 1];
    if (!value || value.startsWith(LONG_PREFIX)) {
      continue;
    }

    options.set(key, value);
    index += 1;
  }

  return {
    positional,
    options,
  };
}

export function readOption(options: ReadonlyMap<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value: string | undefined = options.get(key);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}
