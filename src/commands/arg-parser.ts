export interface ParsedArgs {
  readonly positional: readonly string[];
  readonly options: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly missingOptionValues: ReadonlySet<string>;
  readonly providedOptions: readonly string[];
}

const LONG_PREFIX = "--";

export function parseArgs(args: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const missingOptionValues = new Set<string>();
  const providedOptions: string[] = [];

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
    providedOptions.push(key);
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
    providedOptions,
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

function levenshteinDistance(source: string, target: string): number {
  const sourceLength = source.length;
  const targetLength = target.length;
  if (sourceLength === 0) {
    return targetLength;
  }

  if (targetLength === 0) {
    return sourceLength;
  }

  const previous: number[] = Array.from({ length: targetLength + 1 }, (_, index) => index);
  const current: number[] = new Array<number>(targetLength + 1).fill(0);

  for (let sourceIndex = 1; sourceIndex <= sourceLength; sourceIndex += 1) {
    current[0] = sourceIndex;
    for (let targetIndex = 1; targetIndex <= targetLength; targetIndex += 1) {
      const replacementCost = source[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1;
      const insertCost = (current[targetIndex - 1] ?? 0) + 1;
      const deleteCost = (previous[targetIndex] ?? 0) + 1;
      const replaceCost = (previous[targetIndex - 1] ?? 0) + replacementCost;
      current[targetIndex] = Math.min(
        insertCost,
        deleteCost,
        replaceCost,
      );
    }

    for (let targetIndex = 0; targetIndex <= targetLength; targetIndex += 1) {
      previous[targetIndex] = current[targetIndex] ?? previous[targetIndex] ?? 0;
    }
  }

  return previous[targetLength] ?? 0;
}

function normalizeOption(option: string): string {
  return option.startsWith(LONG_PREFIX) ? option.slice(LONG_PREFIX.length) : option;
}

export function findUnknownOption(parsed: ParsedArgs, allowedOptions: readonly string[]): string | undefined {
  const allowed = new Set<string>(allowedOptions.map(normalizeOption));
  for (const option of parsed.providedOptions) {
    if (!allowed.has(option)) {
      return option;
    }
  }

  return undefined;
}

export function suggestOptions(option: string, allowedOptions: readonly string[], limit = 3): string[] {
  const normalizedOption = normalizeOption(option);
  const normalizedAllowed = allowedOptions.map(normalizeOption);
  return normalizedAllowed
    .map((candidate) => {
      const distance =
        candidate.startsWith(normalizedOption) || normalizedOption.startsWith(candidate)
          ? 0
          : levenshteinDistance(normalizedOption, candidate);
      return {
        candidate,
        distance,
      };
    })
    .sort((left, right) => {
      const byDistance = left.distance - right.distance;
      if (byDistance !== 0) {
        return byDistance;
      }

      return left.candidate.localeCompare(right.candidate);
    })
    .filter((item) => item.distance <= Math.max(2, Math.floor(normalizedOption.length / 2)))
    .slice(0, limit)
    .map((item) => item.candidate);
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
