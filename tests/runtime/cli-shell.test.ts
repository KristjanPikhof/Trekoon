import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { executeShell, parseInvocation } from "../../src/runtime/cli-shell";
import { CLI_VERSION } from "../../src/runtime/version";
import { resolveStoragePaths } from "../../src/storage/path";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-shell-"));
  tempDirs.push(workspace);
  return workspace;
}

function initGitRepository(workspace: string): void {
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("cli shell dispatch", (): void => {
  test("routes help root command to runHelp", async (): Promise<void> => {
    const workspace = createWorkspace();
    const parsed = parseInvocation(["help", "skills"], { stdoutIsTTY: false });

    const result = await executeShell(parsed, workspace);

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("help");
    const data = result.data as { topic: string; text: string };
    expect(data.topic).toBe("skills");
    expect(data.text).toContain("trekoon skills install");
    expect(data.text).toContain("trekoon skills update");
  });

  test("includes package version in root help", async (): Promise<void> => {
    const workspace = createWorkspace();
    const parsed = parseInvocation(["--help"], { stdoutIsTTY: false });

    const result = await executeShell(parsed, workspace);

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("help");
    const data = result.data as { text: string; version: string };
    expect(data.version).toBe(CLI_VERSION);
    expect(data.text).toContain(`Version: ${CLI_VERSION}`);
  });

  test("reports package version for --version", async (): Promise<void> => {
    const workspace = createWorkspace();
    const parsed = parseInvocation(["--version"], { stdoutIsTTY: false });

    const result = await executeShell(parsed, workspace);

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("version");
    expect(result.human).toBe(CLI_VERSION);
    const data = result.data as { version: string };
    expect(data.version).toBe(CLI_VERSION);
  });

  test("shows detailed help for dep/events/migrate/sync/skills", async (): Promise<void> => {
    const workspace = createWorkspace();
    const depHelp = await executeShell(parseInvocation(["dep", "--help"], { stdoutIsTTY: false }), workspace);
    const eventsHelp = await executeShell(parseInvocation(["events", "--help"], { stdoutIsTTY: false }), workspace);
    const migrateHelp = await executeShell(parseInvocation(["migrate", "--help"], { stdoutIsTTY: false }), workspace);
    const syncHelp = await executeShell(parseInvocation(["sync", "--help"], { stdoutIsTTY: false }), workspace);
    const skillsHelp = await executeShell(parseInvocation(["help", "skills"], { stdoutIsTTY: false }), workspace);

    expect(depHelp.ok).toBeTrue();
    expect(eventsHelp.ok).toBeTrue();
    expect(migrateHelp.ok).toBeTrue();
    expect(syncHelp.ok).toBeTrue();
    expect(skillsHelp.ok).toBeTrue();

    const depData = depHelp.data as { topic: string; text: string };
    const eventsData = eventsHelp.data as { topic: string; text: string };
    const migrateData = migrateHelp.data as { topic: string; text: string };
    const syncData = syncHelp.data as { topic: string; text: string };
    const skillsData = skillsHelp.data as { topic: string; text: string };

    expect(depData.topic).toBe("dep");
    expect(depData.text).toContain("Subcommands:");
    expect(depData.text).toContain("trekoon dep reverse <task-b>");

    expect(eventsData.topic).toBe("events");
    expect(eventsData.text).toContain("--dry-run");
    expect(eventsData.text).toContain("default 90");

    expect(migrateData.topic).toBe("migrate");
    expect(migrateData.text).toContain("rollback");
    expect(migrateData.text).toContain("trekoon migrate rollback --to-version 1");

    expect(syncData.topic).toBe("sync");
    expect(syncData.text).toContain("conflicts list");
    expect(syncData.text).toContain("resolve <conflict-id> --use ours|theirs");

    expect(skillsData.topic).toBe("skills");
    expect(skillsData.text).toContain("Install behavior:");
    expect(skillsData.text).toContain("--allow-outside-repo");
  });

  test("shows practical command help for init/quickstart/wipe", async (): Promise<void> => {
    const workspace = createWorkspace();
    const initHelp = await executeShell(parseInvocation(["init", "--help"], { stdoutIsTTY: false }), workspace);
    const quickstartHelp = await executeShell(parseInvocation(["quickstart", "--help"], { stdoutIsTTY: false }), workspace);
    const wipeHelp = await executeShell(parseInvocation(["wipe", "--help"], { stdoutIsTTY: false }), workspace);

    expect(initHelp.ok).toBeTrue();
    expect(quickstartHelp.ok).toBeTrue();
    expect(wipeHelp.ok).toBeTrue();

    const initData = initHelp.data as { topic: string; text: string };
    const quickstartData = quickstartHelp.data as { topic: string; text: string };
    const wipeData = wipeHelp.data as { topic: string; text: string };

    expect(initData.topic).toBe("init");
    expect(initData.text).toContain("Purpose:");
    expect(initData.text).toContain("Initialize local Trekoon storage");

    expect(quickstartData.topic).toBe("quickstart");
    expect(quickstartData.text).toContain("Flow:");
    expect(quickstartData.text).toContain("trekoon --toon task next");

    expect(wipeData.topic).toBe("wipe");
    expect(wipeData.text).toContain("shared repo-wide");
    expect(wipeData.text).toContain("not isolated per worktree");
    expect(wipeData.text).toContain("--yes  Required confirmation for destructive repo-wide removal");
  });

  test("dispatches skills install and creates project-local artifact", async (): Promise<void> => {
    const workspace = createWorkspace();
    const parsed = parseInvocation(["skills", "install"], { stdoutIsTTY: false });

    const result = await executeShell(parsed, workspace);

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("skills.install");

    const data = result.data as { installedPath: string; linked: boolean };
    expect(data.linked).toBeFalse();
    expect(existsSync(data.installedPath)).toBeTrue();
  });

  test("dispatches skills update and refreshes canonical artifact", async (): Promise<void> => {
    const workspace = createWorkspace();
    const parsed = parseInvocation(["skills", "update"], { stdoutIsTTY: false });

    const result = await executeShell(parsed, workspace);

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("skills.update");

    const data = result.data as { installedPath: string; links: Array<{ editor: string }> };
    expect(existsSync(data.installedPath)).toBeTrue();
    expect(data.links.map((entry) => entry.editor)).toEqual(["opencode", "claude", "pi"]);
  });

  test("returns deterministic error for invalid skills invocation", async (): Promise<void> => {
    const workspace = createWorkspace();
    const parsed = parseInvocation(["skills"], { stdoutIsTTY: false });

    const result = await executeShell(parsed, workspace);

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_args");
    expect(result.command).toBe("skills");
  });

  test("dispatches migrate status command", async (): Promise<void> => {
    const workspace = createWorkspace();
    const parsed = parseInvocation(["migrate", "status"], { stdoutIsTTY: false });

    const result = await executeShell(parsed, workspace);

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("migrate.status");
    const data = result.data as { currentVersion: number; latestVersion: number };
    expect(typeof data.currentVersion).toBe("number");
    expect(typeof data.latestVersion).toBe("number");
  });

  test("dispatches events prune command", async (): Promise<void> => {
    const workspace = createWorkspace();
    const parsed = parseInvocation(["events", "prune", "--dry-run"], { stdoutIsTTY: false });

    const result = await executeShell(parsed, workspace);

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("events.prune");
    const data = result.data as { dryRun: boolean };
    expect(data.dryRun).toBeTrue();
  });

  test("rejects unsupported compatibility mode", async (): Promise<void> => {
    const workspace = createWorkspace();
    const parsed = parseInvocation(["sync", "status", "--json", "--compat", "unknown-mode"], { stdoutIsTTY: false });

    const result = await executeShell(parsed, workspace);

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_args");
    expect(result.human).toContain("Unsupported compatibility mode");
  });

  test("rejects missing compatibility mode value", async (): Promise<void> => {
    const workspace = createWorkspace();
    const parsed = parseInvocation(["sync", "status", "--json", "--compat"], { stdoutIsTTY: false });

    const result = await executeShell(parsed, workspace);

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_args");
    expect(result.human).toContain("--compat requires");
  });

  test("rejects compatibility mode for non-sync commands", async (): Promise<void> => {
    const workspace = createWorkspace();
    const parsed = parseInvocation(["task", "list", "--json", "--compat", "legacy-sync-command-ids"], { stdoutIsTTY: false });

    const result = await executeShell(parsed, workspace);

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_args");
    expect(result.human).toContain("only supports sync commands");
  });

  test("adds machine-readable diagnostics for nested cwd", async (): Promise<void> => {
    const workspace = createWorkspace();
    initGitRepository(workspace);
    const nestedCwd = join(workspace, "pkg", "tools", "cli");
    mkdirSync(nestedCwd, { recursive: true });
    const storagePaths = resolveStoragePaths(nestedCwd);

    const result = await executeShell(parseInvocation(["init", "--toon"], { stdoutIsTTY: false }), nestedCwd);

    expect(result.ok).toBeTrue();
    const data = result.data as {
      invocationCwd: string;
      storageMode: string;
      repoCommonDir: string | null;
      worktreeRoot: string;
      sharedStorageRoot: string;
      databaseFile: string;
      legacyStateDetected: boolean;
      recoveryRequired: boolean;
    };
    const meta = result.meta as {
      storageRootDiagnostics?: {
        invocationCwd: string;
        storageMode: string;
        repoCommonDir: string | null;
        worktreeRoot: string;
        sharedStorageRoot: string;
        databaseFile: string;
        legacyStateDetected: boolean;
        recoveryRequired: boolean;
        warnings: Array<{ code: string }>;
        errors: unknown[];
      };
    };

    expect(data.invocationCwd).toBe(nestedCwd);
    expect(data.storageMode).toBe("git_common_dir");
    expect(data.repoCommonDir).toBe(storagePaths.repoCommonDir);
    expect(data.worktreeRoot).toBe(storagePaths.worktreeRoot);
    expect(data.sharedStorageRoot).toBe(storagePaths.sharedStorageRoot);
    expect(data.databaseFile).toBe(storagePaths.databaseFile);
    expect(data.legacyStateDetected).toBeFalse();
    expect(data.recoveryRequired).toBeFalse();

    expect(meta.storageRootDiagnostics?.invocationCwd).toBe(nestedCwd);
    expect(meta.storageRootDiagnostics?.storageMode).toBe("git_common_dir");
    expect(meta.storageRootDiagnostics?.repoCommonDir).toBe(storagePaths.repoCommonDir);
    expect(meta.storageRootDiagnostics?.worktreeRoot).toBe(storagePaths.worktreeRoot);
    expect(meta.storageRootDiagnostics?.sharedStorageRoot).toBe(storagePaths.sharedStorageRoot);
    expect(meta.storageRootDiagnostics?.databaseFile).toBe(storagePaths.databaseFile);
    expect(meta.storageRootDiagnostics?.legacyStateDetected).toBeFalse();
    expect(meta.storageRootDiagnostics?.recoveryRequired).toBeFalse();
    expect(meta.storageRootDiagnostics?.warnings.map((warning) => warning.code)).toEqual(["storage_root_diverged_from_cwd"]);
    expect(meta.storageRootDiagnostics?.errors).toEqual([]);
  });
});
