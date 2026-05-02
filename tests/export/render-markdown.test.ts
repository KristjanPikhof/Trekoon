import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { type Database } from "bun:sqlite";

import { TrackerDomain } from "../../src/domain/tracker-domain";
import { buildEpicExportBundle } from "../../src/export/build-epic-export-bundle";
import { renderMarkdown } from "../../src/export/render-markdown";
import { openTrekoonDatabase, writeTransaction } from "../../src/storage/database";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "trekoon-render-"));
  tempDirs.push(dir);
  return dir;
}

function createDomain(cwd: string): {
  domain: TrackerDomain;
  db: Database;
  seed: <T>(fn: (domain: TrackerDomain) => T) => T;
} {
  const storage = openTrekoonDatabase(cwd);
  const domain = new TrackerDomain(storage.db);
  return {
    domain,
    db: storage.db,
    seed: <T>(fn: (domain: TrackerDomain) => T): T => writeTransaction(storage.db, () => fn(domain)),
  };
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("renderMarkdown", () => {
  test("renders frontmatter with epic metadata", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const epic = seed((d) => d.createEpic({ title: "My Epic", description: "A description" }));
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("---");
    expect(md).toContain(`epic_id: ${epic.id}`);
    expect(md).toContain("schema_version: 1");
    expect(md).toContain("status: todo");
  });

  test("renders title as h1", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const epic = seed((d) => d.createEpic({ title: "Ship the Export", description: "We need this" }));
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("# Ship the Export");
  });

  test("renders summary table with counts", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const epic = seed((d) => {
      const createdEpic = d.createEpic({ title: "Summary Test", description: "Check counts" });
      d.createTask({ epicId: createdEpic.id, title: "T1", description: "D1" });
      d.createTask({ epicId: createdEpic.id, title: "T2", description: "D2" });
      return createdEpic;
    });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("| Tasks | 2 |");
    expect(md).toContain("| Subtasks | 0 |");
  });

  test("renders task index with id-based anchors", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const { epic, task } = seed((d) => {
      const createdEpic = d.createEpic({ title: "Index Test", description: "Check index" });
      const createdTask = d.createTask({ epicId: createdEpic.id, title: "First Task", description: "D1" });
      return { epic: createdEpic, task: createdTask };
    });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("## Task index");
    expect(md).toContain(`[First Task](#task-${task.id})`);
  });

  test("renders task details with id and status", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const { epic, task } = seed((d) => {
      const createdEpic = d.createEpic({ title: "Detail Test", description: "Check detail" });
      const createdTask = d.createTask({ epicId: createdEpic.id, title: "A Task", description: "Task description here" });
      return { epic: createdEpic, task: createdTask };
    });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("### A Task");
    expect(md).toContain(`\`${task.id}\``);
    expect(md).toContain("**Status:** todo");
    expect(md).toContain("Task description here");
  });

  test("renders subtasks as checklist items", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const epic = seed((d) => {
      const createdEpic = d.createEpic({ title: "Subtask Test", description: "Check subtask rendering" });
      const task = d.createTask({ epicId: createdEpic.id, title: "Parent", description: "Has subtasks" });
      d.createSubtask({ taskId: task.id, title: "Sub A", description: "First sub" });
      return createdEpic;
    });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("#### Subtasks");
    expect(md).toContain("- [ ] **Sub A**");
    expect(md).toContain("First sub");
  });

  test("marks done subtasks with checked checkbox", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const epic = seed((d) => {
      const createdEpic = d.createEpic({ title: "Done Sub Test", description: "Check done sub" });
      const task = d.createTask({ epicId: createdEpic.id, title: "Parent", description: "Has done sub" });
      const sub = d.createSubtask({ taskId: task.id, title: "Done Sub", description: "Completed" });
      d.updateSubtask(sub.id, { status: "in_progress" });
      d.updateSubtask(sub.id, { status: "done" });
      return createdEpic;
    });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("- [x] **Done Sub**");
  });

  test("renders dependency table when deps exist", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const epic = seed((d) => {
      const createdEpic = d.createEpic({ title: "Dep Render Test", description: "Check dep table" });
      const t1 = d.createTask({ epicId: createdEpic.id, title: "First", description: "A" });
      const t2 = d.createTask({ epicId: createdEpic.id, title: "Second", description: "B" });
      d.addDependency(t2.id, t1.id);
      return createdEpic;
    });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("## Dependencies");
    expect(md).toContain("| internal |");
  });

  test("renders external nodes section when cross-epic deps exist", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const epicA = seed((d) => {
      const createdEpicA = d.createEpic({ title: "Epic A", description: "First" });
      const createdEpicB = d.createEpic({ title: "Epic B", description: "Second" });
      const taskA = d.createTask({ epicId: createdEpicA.id, title: "Task A", description: "In A" });
      const taskB = d.createTask({ epicId: createdEpicB.id, title: "Task B", description: "In B" });
      d.addDependency(taskA.id, taskB.id);
      return createdEpicA;
    });
    const bundle = buildEpicExportBundle(domain, epicA.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("## External nodes");
    expect(md).toContain("Task B");
  });

  test("renders footer with snapshot disclaimer", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const epic = seed((d) => d.createEpic({ title: "Footer Test", description: "Check footer" }));
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("the database is the source of truth");
  });

  test("escapes pipe characters in table cells", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const epic = seed((d) => {
      const createdEpic = d.createEpic({ title: "Pipe Test", description: "Check pipe escaping" });
      d.createTask({ epicId: createdEpic.id, title: "Fix [auth] | retry", description: "Has pipes" });
      return createdEpic;
    });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    // Task index table cell should escape pipe so it doesn't break the table
    const indexLines = md.split("\n").filter((l) => l.includes("auth"));
    for (const line of indexLines) {
      if (line.startsWith("|")) {
        expect(line).not.toMatch(/\| Fix \[auth\] \| retry/);
        expect(line).toContain("\\|");
      }
    }
  });

  test("escapes brackets and backticks in inline text", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const epic = seed((d) => {
      const createdEpic = d.createEpic({ title: "Bracket Test", description: "Check bracket escaping" });
      const task = d.createTask({ epicId: createdEpic.id, title: "Parent", description: "D" });
      d.createSubtask({ taskId: task.id, title: "Fix `code` and [link]", description: "Has special chars" });
      return createdEpic;
    });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    // Subtask title should have escaped backticks and brackets
    expect(md).toContain("\\`code\\`");
    expect(md).toContain("\\[link\\]");
  });

  test("handles multiline descriptions in subtasks", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const epic = seed((d) => {
      const createdEpic = d.createEpic({ title: "Multiline Test", description: "Check multiline" });
      const task = d.createTask({ epicId: createdEpic.id, title: "Parent", description: "D" });
      d.createSubtask({ taskId: task.id, title: "Sub", description: "Line one\nLine two\nLine three" });
      return createdEpic;
    });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    // Subtask description lines should be indented
    expect(md).toContain("  Line one");
    expect(md).toContain("  Line two");
    expect(md).toContain("  Line three");
  });

  test("duplicate task titles produce unique anchors", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const { epic, t1, t2 } = seed((d) => {
      const createdEpic = d.createEpic({ title: "Dup Test", description: "Check duplicate anchors" });
      const createdT1 = d.createTask({ epicId: createdEpic.id, title: "Same Name", description: "First" });
      const createdT2 = d.createTask({ epicId: createdEpic.id, title: "Same Name", description: "Second" });
      return { epic: createdEpic, t1: createdT1, t2: createdT2 };
    });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    // ID-based anchors must be unique even when titles are identical
    expect(md).toContain(`#task-${t1.id}`);
    expect(md).toContain(`#task-${t2.id}`);
    expect(t1.id).not.toBe(t2.id);
  });

  test("escapes external node titles containing pipes in table", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const epicA = seed((d) => {
      const createdEpicA = d.createEpic({ title: "Epic A", description: "First" });
      const createdEpicB = d.createEpic({ title: "Epic B", description: "Second" });
      const taskA = d.createTask({ epicId: createdEpicA.id, title: "Task A", description: "In A" });
      const taskB = d.createTask({ epicId: createdEpicB.id, title: "Has | pipe", description: "In B" });
      d.addDependency(taskA.id, taskB.id);
      return createdEpicA;
    });
    const bundle = buildEpicExportBundle(domain, epicA.id);
    const md = renderMarkdown(bundle);

    // External nodes table should escape the pipe in the title
    const extLines = md.split("\n").filter((l) => l.includes("pipe"));
    for (const line of extLines) {
      if (line.startsWith("|")) {
        expect(line).toContain("Has \\| pipe");
      }
    }
  });

  test("omits empty sections for empty epic", () => {
    const cwd = createWorkspace();
    const { domain, seed } = createDomain(cwd);
    const epic = seed((d) => d.createEpic({ title: "Empty", description: "Nothing" }));
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).not.toContain("## Tasks");
    expect(md).not.toContain("## Dependencies");
    expect(md).not.toContain("## External nodes");
    expect(md).not.toContain("## Warnings");
  });
});
