export interface ParsedArgs {
  readonly positional: readonly string[];
  readonly options: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly missingOptionValues: ReadonlySet<string>;
}

const LONG_PREFIX = "--";

export function parseArgs(args: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const missingOptionValues = new Set<string>();

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
      flags.add(key);
      missingOptionValues.add(key);
      continue;
    }

    options.set(key, value);
    index += 1;
  }

  return {
    positional,
    options,
    flags,
    missingOptionValues,
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

export function hasFlag(flags: ReadonlySet<string>, ...keys: string[]): boolean {
  return keys.some((key) => flags.has(key));
}

export function readMissingOptionValue(
  missingOptionValues: ReadonlySet<string>,
  ...keys: string[]
): string | undefined {
  return keys.find((key) => missingOptionValues.has(key));
}

export function parseStrictPositiveInt(rawValue: string | undefined): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || `${parsed}` !== rawValue.trim()) {
    return Number.NaN;
  }

  return parsed;
}

export function parseStrictNonNegativeInt(rawValue: string | undefined): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || `${parsed}` !== rawValue.trim()) {
    return Number.NaN;
  }

  return parsed;
}

export function readEnumOption<const T extends readonly string[]>(
  options: ReadonlyMap<string, string>,
  allowed: T,
  ...keys: string[]
): T[number] | undefined {
  const value: string | undefined = readOption(options, ...keys);
  if (value === undefined) {
    return undefined;
  }

  return allowed.includes(value) ? value : undefined;
}
