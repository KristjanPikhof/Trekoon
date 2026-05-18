import {
  COMPACT_TEMP_KEY_PREFIX,
  type CompactEntityRef,
  type CompactEntityIdRef,
  type CompactTempKey,
  type CompactTempKeyRef,
} from "../domain/types";

export interface ParsedArgs {
  readonly positional: readonly string[];
  readonly options: ReadonlyMap<string, string>;
  readonly optionEntries: readonly ParsedOptionEntry[];
  readonly flags: ReadonlySet<string>;
  readonly missingOptionValues: ReadonlySet<string>;
  readonly providedOptions: readonly string[];
}

export interface ParsedOptionEntry {
  readonly key: string;
  readonly value: string;
}

export interface OptionAliasDefinition {
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly multiple?: boolean;
}

export interface OptionAliasConflict {
  readonly canonical: string;
  readonly keys: readonly string[];
}

export interface NormalizedParsedArgsResult {
  readonly parsed: ParsedArgs;
  readonly conflict?: OptionAliasConflict;
}

export const SEARCH_REPLACE_FIELDS = ["title", "description"] as const;

export type SearchReplaceField = (typeof SEARCH_REPLACE_FIELDS)[number];

export interface ParsedCsvEnumOption<T extends string> {
  readonly values: readonly T[];
  readonly invalidValues: readonly string[];
  readonly empty: boolean;
}

export interface PreviewApplyModeSelection {
  readonly mode: "preview" | "apply";
  readonly conflict: boolean;
}

export interface ParsedCompactFields {
  readonly fields: readonly string[];
  readonly invalidEscape: string | null;
  readonly hasDanglingEscape: boolean;
}

const LONG_PREFIX = "--";
const SHORT_FLAG_PATTERN = /^-([A-Za-z])$/u;

export function parseArgs(args: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const optionEntries: ParsedOptionEntry[] = [];
  const flags = new Set<string>();
  const missingOptionValues = new Set<string>();
  const providedOptions: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token: string | undefined = args[index];
    if (!token) {
      continue;
    }

    // Short flag: single dash + single letter (e.g. -g).
    const shortMatch = SHORT_FLAG_PATTERN.exec(token);
    if (shortMatch) {
      const key: string = shortMatch[1]!;
      flags.add(key);
      providedOptions.push(key);
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
    optionEntries.push({ key, value });
    index += 1;
  }

  return {
    positional,
    options,
    optionEntries,
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

export function readOptions(optionEntries: readonly ParsedOptionEntry[], ...keys: string[]): string[] {
  const allowedKeys = new Set<string>(keys);
  return optionEntries.filter((entry) => allowedKeys.has(entry.key)).map((entry) => entry.value);
}

export function normalizeOptionAliases(
  parsed: ParsedArgs,
  definitions: readonly OptionAliasDefinition[],
): NormalizedParsedArgsResult {
  const aliases = new Map<string, OptionAliasDefinition>();
  for (const definition of definitions) {
    aliases.set(definition.canonical, definition);
    for (const alias of definition.aliases) {
      aliases.set(alias, definition);
    }
  }

  const rewriteKey = (key: string): string => aliases.get(key)?.canonical ?? key;
  for (const definition of definitions) {
    if (definition.multiple === true) {
      continue;
    }

    const keys = parsed.optionEntries
      .filter((entry) => rewriteKey(entry.key) === definition.canonical)
      .map((entry) => entry.key);
    const usesAlias = keys.some((key) => key !== definition.canonical);
    if (keys.length > 1 && usesAlias) {
      return {
        parsed,
        conflict: {
          canonical: definition.canonical,
          keys,
        },
      };
    }
  }

  const optionEntries = parsed.optionEntries.map((entry) => ({
    key: rewriteKey(entry.key),
    value: entry.value,
  }));
  const options = new Map<string, string>();
  for (const entry of optionEntries) {
    options.set(entry.key, entry.value);
  }

  return {
    parsed: {
      positional: parsed.positional,
      options,
      optionEntries,
      flags: new Set([...parsed.flags].map(rewriteKey)),
      missingOptionValues: new Set([...parsed.missingOptionValues].map(rewriteKey)),
      providedOptions: parsed.providedOptions.map(rewriteKey),
    },
  };
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

export function parseCsvOption(rawValue: string | undefined): string[] | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function parseCsvEnumOption<const T extends readonly string[]>(
  rawValue: string | undefined,
  allowed: T,
): ParsedCsvEnumOption<T[number]> {
  const values = parseCsvOption(rawValue);
  if (values === undefined) {
    return {
      values: [...allowed],
      invalidValues: [],
      empty: false,
    };
  }

  if (values.length === 0) {
    return {
      values: [...allowed],
      invalidValues: [],
      empty: true,
    };
  }

  const allowedValues = new Set<string>(allowed);
  const validValues: T[number][] = [];
  const invalidValues: string[] = [];

  for (const value of values) {
    if (!allowedValues.has(value)) {
      invalidValues.push(value);
      continue;
    }

    if (!validValues.includes(value as T[number])) {
      validValues.push(value as T[number]);
    }
  }

  return {
    values: validValues.length > 0 ? validValues : [...allowed],
    invalidValues,
    empty: false,
  };
}

export function resolvePreviewApplyMode(
  flags: ReadonlySet<string>,
  previewKey = "preview",
  applyKey = "apply",
): PreviewApplyModeSelection {
  const preview = flags.has(previewKey);
  const apply = flags.has(applyKey);
  return {
    mode: apply ? "apply" : "preview",
    conflict: preview && apply,
  };
}

export function isValidCompactTempKey(value: string): value is CompactTempKey {
  return /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(value);
}

export function parseCompactFields(rawValue: string): ParsedCompactFields {
  const fields: string[] = [];
  let current = "";
  let escaping = false;

  for (const character of rawValue) {
    if (escaping) {
      switch (character) {
        case "|":
          current += "|";
          break;
        case "\\":
          current += "\\";
          break;
        case "n":
          current += "\n";
          break;
        case "r":
          current += "\r";
          break;
        case "t":
          current += "\t";
          break;
        default:
          return {
            fields,
            invalidEscape: `\\${character}`,
            hasDanglingEscape: false,
          };
      }

      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (character === "|") {
      fields.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  if (escaping) {
    return {
      fields,
      invalidEscape: null,
      hasDanglingEscape: true,
    };
  }

  fields.push(current);
  return {
    fields,
    invalidEscape: null,
    hasDanglingEscape: false,
  };
}

export function endsWithBareCompactPipe(rawSpec: string): boolean {
  if (!rawSpec.endsWith("|")) {
    return false;
  }
  let backslashes = 0;
  for (let i = rawSpec.length - 2; i >= 0 && rawSpec[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 0;
}

export function containsBareDoubleCompactPipe(rawSpec: string): boolean {
  let escaping = false;
  let prevBarePipe = false;
  for (const character of rawSpec) {
    if (escaping) {
      escaping = false;
      prevBarePipe = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      prevBarePipe = false;
      continue;
    }
    if (character === "|") {
      if (prevBarePipe) {
        return true;
      }
      prevBarePipe = true;
      continue;
    }
    prevBarePipe = false;
  }
  return false;
}

export function describeCompactPipeIssue(rawSpec: string): string {
  const doublePipe = containsBareDoubleCompactPipe(rawSpec);
  const trailingPipe = endsWithBareCompactPipe(rawSpec);
  if (doublePipe && trailingPipe) {
    return "Spec has bare `||` and ends with a trailing `|`. `||` (logical-OR or back-to-back pipes) adds two extra fields per occurrence; a trailing `|` creates an empty final field. Escape literal pipes as `\\|` or rephrase (e.g. `||` -> `or`), and drop the trailing `|`.";
  }
  if (doublePipe) {
    return "Spec has bare `||` (two pipes back-to-back) — common with JS logical-OR (`a || b`) or shell OR (`cmd a || cmd b`). Every unescaped `|` adds a field, so `||` adds two extra fields. Escape literal pipes as `\\|` or rephrase the operator (e.g. `||` -> `or`).";
  }
  if (trailingPipe) {
    return "Spec ends with a bare `|`. The trailing `|` is not a terminator — it creates an empty final field. Drop the trailing `|`.";
  }
  return "Bare `|` inside a field value is a field separator. Escape literal pipes as `\\|` or rephrase the value to avoid `|`.";
}

export function parseCompactEntityRef(rawValue: string): CompactEntityRef {
  if (rawValue.startsWith(COMPACT_TEMP_KEY_PREFIX)) {
    const tempKey = rawValue.slice(COMPACT_TEMP_KEY_PREFIX.length);
    return {
      kind: "temp_key",
      tempKey,
    } satisfies CompactTempKeyRef;
  }

  return {
    kind: "id",
    id: rawValue,
  } satisfies CompactEntityIdRef;
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

export function readUnexpectedPositionals(parsed: ParsedArgs, expectedCount: number): readonly string[] {
  return parsed.positional.slice(expectedCount);
}
