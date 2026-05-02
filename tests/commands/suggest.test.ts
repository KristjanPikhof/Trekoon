import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runEpic } from "../../src/commands/epic";
import { runSuggest } from "../../src/commands/suggest";
import { TrackerDomain } from "../../src/domain/tracker-domain";
import { openTrekoonDatabase } from "../../src/storage/database";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-suggest-"));
  tempDirs.push(workspace);
  return workspace;
}

function runGit(cwd: string, args: readonly string[]): void {
  const command = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (command.exitCode !== 0) {
    const stderr = new TextDecoder().decode(command.stderr).trim();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

function initializeRepository(workspace: string): void {
  runGit(workspace, ["init", "-b", "main"]);
  runGit(workspace, ["config", "user.email", "tests@trekoon.local"]);
  runGit(workspace, ["config", "user.name", "Trekoon Tests"]);
  writeFileSync(join(workspace, "README.md"), "# test repo\n");
  writeFileSync(join(workspace, ".gitignore"), ".trekoon/\n");
  runGit(workspace, ["add", "README.md", ".gitignore"]);
  runGit(workspace, ["commit", "-m", "init repository"]);
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const workspace = tempDirs.pop();
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// findActiveEpic selection logic (via suggest context.activeEpic)
// ---------------------------------------------------------------------------

describe("findActiveEpic selection logic", (): void => {
  test("returns in_progress epic when one exists", async (): Promise<void> => {
    const cwd = createWorkspace();
    initializeRepository(cwd);

    // Create a todo epic then advance it to in_progress
    const created = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Active Epic", "--description", "desc"],
    });
    const epicId = (created.data as { epic: { id: string } }).epic.id;

    await runEpic({
      cwd,
      mode: "toon",
      args: ["update", epicId, "--status", "in_progress"],
    });

    const result = await runSuggest({ cwd, mode: "toon", args: [] });

    expect(result.ok).toBeTrue();
    const data = result.data as { context: { activeEpic: string | null } };
    expect(data.context.activeEpic).toBe(epicId);
  });

  test("returns most-recently-updated todo epic when no in_progress epic exists", async (): Promise<void> => {
    const cwd = createWorkspace();
    initializeRepository(cwd);

    // Create two todo epics; update the second one so it has a later updated_at
    await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Older Todo", "--description", "first"],
    });

    const created2 = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Newer Todo", "--description", "second"],
    });
    const newerEpicId = (created2.data as { epic: { id: string } }).epic.id;

    // Touch the newer epic to bump updated_at beyond the older one
    await runEpic({
      cwd,
      mode: "toon",
      args: ["update", newerEpicId, "--description", "second (touched)"],
    });

    const result = await runSuggest({ cwd, mode: "toon", args: [] });

    expect(result.ok).toBeTrue();
    const data = result.data as { context: { activeEpic: string | null } };
    expect(data.context.activeEpic).toBe(newerEpicId);
  });

  test("returns null and suggests quickstart when no epics exist", async (): Promise<void> => {
    const cwd = createWorkspace();
    initializeRepository(cwd);

    const result = await runSuggest({ cwd, mode: "toon", args: [] });

    expect(result.ok).toBeTrue();
    const data = result.data as {
      context: { activeEpic: string | null; totalEpics: number };
      suggestions: readonly { action: string }[];
    };
    expect(data.context.activeEpic).toBeNull();
    expect(data.context.totalEpics).toBe(0);

    const actions = data.suggestions.map((s) => s.action);
    expect(actions).toContain("quickstart");
  });
});

// ---------------------------------------------------------------------------
// findActiveEpic unit-level tests via TrackerDomain directly
// ---------------------------------------------------------------------------

describe("TrackerDomain.findActiveEpic", (): void => {
  function openDomain(cwd: string): TrackerDomain {
    const db = openTrekoonDatabase(cwd);
    tempDirs.push(cwd); // already registered, but db.close handled by GC in tests
    return new TrackerDomain(db.db);
  }

  test("returns in_progress epic when one exists", (): void => {
    const cwd = createWorkspace();
    initializeRepository(cwd);
    const db = openTrekoonDatabase(cwd);
    const domain = new TrackerDomain(db.db);

    const epic = domain.writeTransaction(() =>
      domain.createEpic({ title: "IP Epic", description: "desc", status: "in_progress" }),
    );

    const active = domain.findActiveEpic();
    expect(active?.id).toBe(epic.id);

    db.close();
  });

  test("returns most-recently-updated todo when no in_progress exists", (): void => {
    const cwd = createWorkspace();
    initializeRepository(cwd);
    const db = openTrekoonDatabase(cwd);
    const domain = new TrackerDomain(db.db);

    domain.writeTransaction(() => {
      domain.createEpic({ title: "Old Todo", description: "desc" });
    });

    // Small delay to ensure distinct updated_at timestamps
    Bun.sleepSync(2);

    const newer = domain.writeTransaction(() =>
      domain.createEpic({ title: "New Todo", description: "desc" }),
    );

    const active = domain.findActiveEpic();
    expect(active?.id).toBe(newer.id);

    db.close();
  });

  test("returns null when no epics exist", (): void => {
    const cwd = createWorkspace();
    initializeRepository(cwd);
    const db = openTrekoonDatabase(cwd);
    const domain = new TrackerDomain(db.db);

    const active = domain.findActiveEpic();
    expect(active).toBeNull();

    db.close();
  });
});
