import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  buildMatchSnippet,
  buildReplacementSnippet,
  collectSearchMatches,
  countMatches,
  replaceMatches,
  summarizeMatches,
} from "../../src/domain/search";
import { TrackerDomain } from "../../src/domain/tracker-domain";
import { migrateDatabase } from "../../src/storage/migrations";
import { writeTransaction } from "../../src/storage/database";

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrateDatabase(db);
  return db;
}

// ---------------------------------------------------------------------------
// countMatches
// ---------------------------------------------------------------------------

describe("countMatches", (): void => {
  test("returns 0 for empty searchText", (): void => {
    expect(countMatches("hello world", "")).toBe(0);
  });

  test("returns 0 when no match", (): void => {
    expect(countMatches("hello world", "xyz")).toBe(0);
  });

  test("returns 1 for single match", (): void => {
    expect(countMatches("hello world", "world")).toBe(1);
  });

  test("returns correct count for multiple non-overlapping matches", (): void => {
    expect(countMatches("ababab", "ab")).toBe(3);
  });

  test("does not double-count overlapping positions", (): void => {
    // "aaa" contains "aa" at positions 0 and 1, but non-overlapping gives 1
    expect(countMatches("aaa", "aa")).toBe(1);
  });

  test("handles match at the very start", (): void => {
    expect(countMatches("foobar", "foo")).toBe(1);
  });

  test("handles match at the very end", (): void => {
    expect(countMatches("foobar", "bar")).toBe(1);
  });

  test("handles full string match", (): void => {
    expect(countMatches("exact", "exact")).toBe(1);
  });

  test("empty value returns 0", (): void => {
    expect(countMatches("", "x")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildMatchSnippet
// ---------------------------------------------------------------------------

describe("buildMatchSnippet", (): void => {
  test("returns empty string for empty searchText", (): void => {
    expect(buildMatchSnippet("hello", "")).toBe("");
  });

  test("returns empty string when no match", (): void => {
    expect(buildMatchSnippet("hello", "xyz")).toBe("");
  });

  test("returns snippet with ellipsis when context is truncated at start", (): void => {
    const value = "a".repeat(30) + "target" + "b".repeat(30);
    const snippet = buildMatchSnippet(value, "target", 5);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet).toContain("target");
  });

  test("returns snippet with ellipsis when context is truncated at end", (): void => {
    const value = "target" + "b".repeat(30);
    const snippet = buildMatchSnippet(value, "target", 5);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("target");
  });

  test("returns full string snippet without ellipsis when value is short", (): void => {
    const snippet = buildMatchSnippet("hello world", "world");
    expect(snippet).toBe("hello world");
    expect(snippet.startsWith("…")).toBe(false);
    expect(snippet.endsWith("…")).toBe(false);
  });

  test("collapses whitespace in snippet", (): void => {
    const snippet = buildMatchSnippet("hello   world", "world");
    expect(snippet).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// summarizeMatches
// ---------------------------------------------------------------------------

describe("summarizeMatches", (): void => {
  test("returns zeroes for empty matches array", (): void => {
    expect(summarizeMatches([])).toEqual({
      matchedEntities: 0,
      matchedFields: 0,
      totalMatches: 0,
    });
  });

  test("correctly sums entities, fields, and match counts", (): void => {
    const matches = [
      {
        kind: "task" as const,
        id: "t1",
        fields: [
          { field: "title" as const, count: 2, snippet: "…" },
          { field: "description" as const, count: 3, snippet: "…" },
        ],
      },
      {
        kind: "subtask" as const,
        id: "s1",
        fields: [{ field: "title" as const, count: 1, snippet: "…" }],
      },
    ];

    expect(summarizeMatches(matches)).toEqual({
      matchedEntities: 2,
      matchedFields: 3,
      totalMatches: 6,
    });
  });
});

// ---------------------------------------------------------------------------
// replaceMatches
// ---------------------------------------------------------------------------

describe("replaceMatches", (): void => {
  test("returns original when searchText is empty", (): void => {
    expect(replaceMatches("hello", "", "X")).toBe("hello");
  });

  test("replaces all occurrences", (): void => {
    expect(replaceMatches("ababab", "ab", "Z")).toBe("ZZZ");
  });

  test("returns original when no match", (): void => {
    expect(replaceMatches("hello", "xyz", "Z")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// buildReplacementSnippet
// ---------------------------------------------------------------------------

describe("buildReplacementSnippet", (): void => {
  test("returns a snippet around the replacement position", (): void => {
    const value = "hello REPLACEMENT world";
    const replacementIndex = 6;
    const replacementLength = 11;
    const snippet = buildReplacementSnippet(value, replacementIndex, replacementLength, 5);
    expect(snippet).toContain("REPLACEMENT");
  });

  test("adds leading ellipsis when truncated at start", (): void => {
    const value = "a".repeat(30) + "REPLACEMENT" + "b".repeat(10);
    const snippet = buildReplacementSnippet(value, 30, 11, 5);
    expect(snippet.startsWith("…")).toBe(true);
  });

  test("adds trailing ellipsis when truncated at end", (): void => {
    const value = "REPLACEMENT" + "b".repeat(30);
    const snippet = buildReplacementSnippet(value, 0, 11, 5);
    expect(snippet.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectSearchMatches
// ---------------------------------------------------------------------------

describe("collectSearchMatches", (): void => {
  test("returns empty array when no nodes match", (): void => {
    const nodes = [
      { kind: "task" as const, id: "t1", title: "buy milk", description: "groceries" },
    ];
    expect(collectSearchMatches(nodes, "xyz", ["title", "description"])).toEqual([]);
  });

  test("returns empty array for empty searchText", (): void => {
    const nodes = [
      { kind: "task" as const, id: "t1", title: "buy milk", description: "groceries" },
    ];
    expect(collectSearchMatches(nodes, "", ["title", "description"])).toEqual([]);
  });

  test("matches on title only when specified", (): void => {
    const nodes = [
      { kind: "task" as const, id: "t1", title: "buy milk", description: "buy more milk" },
    ];
    const result = collectSearchMatches(nodes, "buy", ["title"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.fields).toHaveLength(1);
    expect(result[0]!.fields[0]!.field).toBe("title");
  });

  test("matches on both fields when both specified", (): void => {
    const nodes = [
      { kind: "task" as const, id: "t1", title: "buy milk", description: "buy more milk" },
    ];
    const result = collectSearchMatches(nodes, "buy", ["title", "description"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.fields).toHaveLength(2);
  });

  test("skips nodes with no matches", (): void => {
    const nodes = [
      { kind: "task" as const, id: "t1", title: "buy milk", description: "groceries" },
      { kind: "task" as const, id: "t2", title: "read book", description: "fiction" },
    ];
    const result = collectSearchMatches(nodes, "buy", ["title", "description"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("t1");
  });

  test("preserves kind and id from node", (): void => {
    const nodes = [
      { kind: "epic" as const, id: "e1", title: "feature A", description: "desc" },
    ];
    const result = collectSearchMatches(nodes, "feature", ["title"]);
    expect(result[0]!.kind).toBe("epic");
    expect(result[0]!.id).toBe("e1");
  });
});

// ---------------------------------------------------------------------------
// Integration: TrackerDomain.searchEpicScope (round-trip)
// ---------------------------------------------------------------------------

describe("TrackerDomain.searchEpicScope integration", (): void => {
  test("finds matches across epic, task, and subtask titles and descriptions", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let epicId!: string;
    let taskId!: string;

    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "search keyword here", description: "no match" });
      epicId = epic.id;
      const task = domain.createTask({ epicId, title: "no match", description: "keyword in description" });
      taskId = task.id;
      domain.createSubtask({ taskId, title: "subtask no match" });
    });

    const result = domain.searchEpicScope(epicId, "keyword", ["title", "description"]);

    // epic title and task description both contain "keyword"
    expect(result.matches).toHaveLength(2);
    expect(result.summary.matchedEntities).toBe(2);
    expect(result.summary.totalMatches).toBe(2);

    const epicMatch = result.matches.find((m) => m.kind === "epic");
    expect(epicMatch).toBeDefined();
    expect(epicMatch!.fields[0]!.field).toBe("title");

    const taskMatch = result.matches.find((m) => m.kind === "task");
    expect(taskMatch).toBeDefined();
    expect(taskMatch!.fields[0]!.field).toBe("description");
  });

  test("searchTaskScope returns only task and its subtasks", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let taskId!: string;

    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "epic", description: "term" });
      const task = domain.createTask({ epicId: epic.id, title: "task with term", description: "no" });
      taskId = task.id;
      domain.createSubtask({ taskId, title: "subtask with term" });
    });

    const result = domain.searchTaskScope(taskId, "term", ["title", "description"]);

    // Only task title and subtask title — epic is outside scope
    expect(result.matches).toHaveLength(2);
    const kinds = result.matches.map((m) => m.kind).sort();
    expect(kinds).toEqual(["subtask", "task"]);
  });

  test("returns empty matches and zeroed summary when nothing matches", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let epicId!: string;

    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "nothing here", description: "nope" });
      epicId = epic.id;
    });

    const result = domain.searchEpicScope(epicId, "xyzzy", ["title", "description"]);
    expect(result.matches).toHaveLength(0);
    expect(result.summary).toEqual({ matchedEntities: 0, matchedFields: 0, totalMatches: 0 });
  });
});
