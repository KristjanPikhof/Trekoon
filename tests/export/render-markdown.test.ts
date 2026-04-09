import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { TrackerDomain } from "../../src/domain/tracker-domain";
import { buildEpicExportBundle } from "../../src/export/build-epic-export-bundle";
import { renderMarkdown } from "../../src/export/render-markdown";
import { openTrekoonDatabase } from "../../src/storage/database";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "trekoon-render-"));
  tempDirs.push(dir);
  return dir;
}

function createDomain(cwd: string): TrackerDomain {
  const db = openTrekoonDatabase(cwd);
  return new TrackerDomain(db.db);
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
    const domain = createDomain(cwd);
    const epic = domain.createEpic({ title: "My Epic", description: "A description" });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("---");
    expect(md).toContain(`epic_id: ${epic.id}`);
    expect(md).toContain("schema_version: 1");
    expect(md).toContain("status: todo");
  });

  test("renders title as h1", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);
    const epic = domain.createEpic({ title: "Ship the Export", description: "We need this" });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("# Ship the Export");
  });

  test("renders summary table with counts", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);
    const epic = domain.createEpic({ title: "Summary Test", description: "Check counts" });
    domain.createTask({ epicId: epic.id, title: "T1", description: "D1" });
    domain.createTask({ epicId: epic.id, title: "T2", description: "D2" });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("| Tasks | 2 |");
    expect(md).toContain("| Subtasks | 0 |");
  });

  test("renders task index with anchors", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);
    const epic = domain.createEpic({ title: "Index Test", description: "Check index" });
    domain.createTask({ epicId: epic.id, title: "First Task", description: "D1" });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("## Task index");
    expect(md).toContain("[First Task](#first-task)");
  });

  test("renders task details with id and status", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);
    const epic = domain.createEpic({ title: "Detail Test", description: "Check detail" });
    const task = domain.createTask({ epicId: epic.id, title: "A Task", description: "Task description here" });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("### A Task");
    expect(md).toContain(`\`${task.id}\``);
    expect(md).toContain("**Status:** todo");
    expect(md).toContain("Task description here");
  });

  test("renders subtasks as checklist items", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);
    const epic = domain.createEpic({ title: "Subtask Test", description: "Check subtask rendering" });
    const task = domain.createTask({ epicId: epic.id, title: "Parent", description: "Has subtasks" });
    domain.createSubtask({ taskId: task.id, title: "Sub A", description: "First sub" });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("#### Subtasks");
    expect(md).toContain("- [ ] **Sub A**");
    expect(md).toContain("First sub");
  });

  test("marks done subtasks with checked checkbox", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);
    const epic = domain.createEpic({ title: "Done Sub Test", description: "Check done sub" });
    const task = domain.createTask({ epicId: epic.id, title: "Parent", description: "Has done sub" });
    const sub = domain.createSubtask({ taskId: task.id, title: "Done Sub", description: "Completed" });
    domain.updateSubtask(sub.id, { status: "in_progress" });
    domain.updateSubtask(sub.id, { status: "done" });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("- [x] **Done Sub**");
  });

  test("renders dependency table when deps exist", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);
    const epic = domain.createEpic({ title: "Dep Render Test", description: "Check dep table" });
    const t1 = domain.createTask({ epicId: epic.id, title: "First", description: "A" });
    const t2 = domain.createTask({ epicId: epic.id, title: "Second", description: "B" });
    domain.addDependency(t2.id, t1.id);
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("## Dependencies");
    expect(md).toContain("| internal |");
  });

  test("renders external nodes section when cross-epic deps exist", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);
    const epicA = domain.createEpic({ title: "Epic A", description: "First" });
    const epicB = domain.createEpic({ title: "Epic B", description: "Second" });
    const taskA = domain.createTask({ epicId: epicA.id, title: "Task A", description: "In A" });
    const taskB = domain.createTask({ epicId: epicB.id, title: "Task B", description: "In B" });
    domain.addDependency(taskA.id, taskB.id);
    const bundle = buildEpicExportBundle(domain, epicA.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("## External nodes");
    expect(md).toContain("Task B");
  });

  test("renders footer with snapshot disclaimer", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);
    const epic = domain.createEpic({ title: "Footer Test", description: "Check footer" });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).toContain("the database is the source of truth");
  });

  test("omits empty sections for empty epic", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);
    const epic = domain.createEpic({ title: "Empty", description: "Nothing" });
    const bundle = buildEpicExportBundle(domain, epic.id);
    const md = renderMarkdown(bundle);

    expect(md).not.toContain("## Tasks");
    expect(md).not.toContain("## Dependencies");
    expect(md).not.toContain("## External nodes");
    expect(md).not.toContain("## Warnings");
  });
});
