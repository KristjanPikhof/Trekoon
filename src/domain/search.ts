import {
  type SearchEntityMatch,
  type SearchField,
  type SearchFieldMatch,
  type SearchNode,
  type SearchSummary,
} from "./types";

// ---------------------------------------------------------------------------
// Pure search helpers — no DB access, no class state.
// Used by TrackerDomain (search methods) and MutationService (replace methods).
// ---------------------------------------------------------------------------

export function countMatches(value: string, searchText: string): number {
  if (searchText.length === 0) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (offset <= value.length - searchText.length) {
    const nextIndex = value.indexOf(searchText, offset);
    if (nextIndex === -1) {
      return count;
    }

    count += 1;
    offset = nextIndex + searchText.length;
  }

  return count;
}

export function buildMatchSnippet(value: string, searchText: string, contextSize = 24): string {
  if (searchText.length === 0) {
    return "";
  }

  const matchIndex = value.indexOf(searchText);
  if (matchIndex === -1) {
    return "";
  }

  const start = Math.max(0, matchIndex - contextSize);
  const end = Math.min(value.length, matchIndex + searchText.length + contextSize);
  const rawSnippet = value.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  return `${prefix}${rawSnippet}${suffix}`;
}

export function summarizeMatches(matches: readonly SearchEntityMatch[]): SearchSummary {
  return {
    matchedEntities: matches.length,
    matchedFields: matches.reduce((total, match) => total + match.fields.length, 0),
    totalMatches: matches.reduce(
      (total, match) => total + match.fields.reduce((fieldTotal, field) => fieldTotal + field.count, 0),
      0,
    ),
  };
}

export function replaceMatches(value: string, searchText: string, replacement: string): string {
  return searchText.length === 0 ? value : value.split(searchText).join(replacement);
}

export function buildReplacementSnippet(
  value: string,
  replacementIndex: number,
  replacementLength: number,
  contextSize = 24,
): string {
  const start = Math.max(0, replacementIndex - contextSize);
  const end = Math.min(value.length, replacementIndex + replacementLength + contextSize);
  const rawSnippet = value.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  return `${prefix}${rawSnippet}${suffix}`;
}

export function collectSearchMatches(
  nodes: readonly SearchNode[],
  searchText: string,
  fields: readonly SearchField[],
): readonly SearchEntityMatch[] {
  const matches: SearchEntityMatch[] = [];

  for (const node of nodes) {
    const matchedFields: SearchFieldMatch[] = [];
    for (const field of fields) {
      const count = countMatches(node[field], searchText);
      if (count > 0) {
        matchedFields.push({
          field,
          count,
          snippet: buildMatchSnippet(node[field], searchText),
        });
      }
    }

    if (matchedFields.length === 0) {
      continue;
    }

    matches.push({
      kind: node.kind,
      id: node.id,
      fields: matchedFields,
    });
  }

  return matches;
}
