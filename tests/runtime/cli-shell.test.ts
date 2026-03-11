import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { executeShell, parseInvocation } from "../../src/runtime/cli-shell";
import { CLI_VERSION } from "../../src/runtime/version";
import { migrateDatabase } from "../../src/storage/migrations";
import { resolveLegacyWorktreeDatabaseFile, resolveStoragePaths } from "../../src/storage/path";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-shell-"));
  tempDirs.push(workspace);
  return workspace;
}

function initGitRepository(workspace: string): void {
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
}

function createCommittedGitRepository(workspace: string): void {
  initGitRepository(workspace);
  writeFileSync(join(workspace, "README.md"), "# Trekoon\n", "utf8");
  writeFileSync(join(workspace, ".gitignore"), ".trekoon/\n", "utf8");
  execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: workspace, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Trekoon Tests", "-c", "user.email=tests@trekoon.local", "commit", "-m", "Initial commit"],
    { cwd: workspace, stdio: "ignore" },
  );
}

function createLegacyDatabaseFile(workspace: string, title: string): string {
  const databaseFile = resolveLegacyWorktreeDatabaseFile(workspace);
  mkdirSync(join(workspace, ".trekoon"), { recursive: true });
  const db = new Database(databaseFile, { create: true });

  try {
    migrateDatabase(db);
    db.exec("PRAGMA foreign_keys = ON;");
    db.query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?);").run(
      `epic-${title}`,
      title,
      `Legacy ${title}`,
      "todo",
      1,
      1,
      1,
    );
  } finally {
    db.close(false);
  }

  return realpathSync(databaseFile);
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
    expect(initData.text).toContain("Initialize repo-scoped Trekoon storage");
    expect(initData.text).toContain("Keep .trekoon gitignored");

    expect(quickstartData.topic).toBe("quickstart");
    expect(quickstartData.text).toContain("Flow:");
    expect(quickstartData.text).toContain("trekoon --toon init");
    expect(quickstartData.text).toContain("Fail fast on recoveryRequired");
    expect(quickstartData.text).toContain("trekoon --toon task next");

    expect(wipeData.topic).toBe("wipe");
    expect(wipeData.text).toContain("shared Trekoon storage directory");
    expect(wipeData.text).toContain("same .trekoon state for every linked worktree");
    expect(wipeData.text).toContain("--yes  Required confirmation for destructive repo-wide removal");
    expect(wipeData.text).toContain("Do not use wipe to fix gitignore mistakes");
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
        recoveryStatus: string;
        legacyDatabaseFiles: string[];
        backupFiles: string[];
        trackedStorageFiles: string[];
        autoMigratedLegacyState: boolean;
        importedFromLegacyDatabase: string | null;
        operatorAction: string;
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
    expect(meta.storageRootDiagnostics?.recoveryStatus).toBe("no_legacy_state");
    expect(meta.storageRootDiagnostics?.legacyDatabaseFiles).toEqual([]);
    expect(meta.storageRootDiagnostics?.backupFiles).toEqual([]);
    expect(meta.storageRootDiagnostics?.trackedStorageFiles).toEqual([]);
    expect(meta.storageRootDiagnostics?.autoMigratedLegacyState).toBeFalse();
    expect(meta.storageRootDiagnostics?.importedFromLegacyDatabase).toBeNull();
    expect(meta.storageRootDiagnostics?.operatorAction).toBe("No legacy worktree-local database detected.");
    expect(meta.storageRootDiagnostics?.warnings.map((warning) => warning.code)).toEqual(["storage_root_diverged_from_cwd"]);
    expect(meta.storageRootDiagnostics?.errors).toEqual([]);
  });

  test("surfaces machine-readable tracked storage mismatch data", async (): Promise<void> => {
    const workspace = createWorkspace();
    createCommittedGitRepository(workspace);
    mkdirSync(join(workspace, ".trekoon"), { recursive: true });
    const trackedFile = join(workspace, ".trekoon", "tracked.txt");
    writeFileSync(trackedFile, "tracked state\n", "utf8");
    execFileSync("git", ["add", "-f", trackedFile], { cwd: workspace, stdio: "ignore" });

    const result = await executeShell(parseInvocation(["init", "--toon"], { stdoutIsTTY: false }), workspace);
    const storagePaths = resolveStoragePaths(workspace);

    expect(result.ok).toBeFalse();
    expect(result.command).toBe("init");
    expect(result.error?.code).toBe("tracked_ignored_mismatch");
    const data = result.data as {
      status: string;
      legacyDatabaseFiles: string[];
      trackedStorageFiles: string[];
      operatorAction: string;
    };

    expect(data.status).toBe("tracked_ignored_mismatch");
    expect(data.legacyDatabaseFiles).toEqual([]);
    expect(data.trackedStorageFiles).toEqual([realpathSync(trackedFile)]);
    expect(data.operatorAction).toContain("git rm --cached -r --");

    const meta = result.meta as {
      storageRootDiagnostics?: {
        worktreeRoot: string;
        sharedStorageRoot: string;
        databaseFile: string;
        recoveryRequired: boolean;
        recoveryStatus: string;
        trackedStorageFiles: string[];
        operatorAction: string;
        warnings: Array<{ code: string }>;
      };
    };

    expect(meta.storageRootDiagnostics?.worktreeRoot).toBe(storagePaths.worktreeRoot);
    expect(meta.storageRootDiagnostics?.sharedStorageRoot).toBe(storagePaths.sharedStorageRoot);
    expect(meta.storageRootDiagnostics?.databaseFile).toBe(storagePaths.databaseFile);
    expect(meta.storageRootDiagnostics?.recoveryRequired).toBeTrue();
    expect(meta.storageRootDiagnostics?.recoveryStatus).toBe("tracked_ignored_mismatch");
    expect(meta.storageRootDiagnostics?.trackedStorageFiles).toEqual([realpathSync(trackedFile)]);
    expect(meta.storageRootDiagnostics?.operatorAction).toContain("git rm --cached -r --");
    expect(meta.storageRootDiagnostics?.warnings.map((warning) => warning.code)).toEqual(["storage_root_diverged_from_cwd"]);
  });

  test("help diagnostics do not create shared storage or import legacy state", async (): Promise<void> => {
    const workspace = createWorkspace();
    createCommittedGitRepository(workspace);
    const linkedWorktree = createWorkspace();

    execFileSync("git", ["worktree", "add", "-b", "shell-help-readonly", linkedWorktree, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });

    const legacyDatabaseFile = join(linkedWorktree, ".trekoon", "trekoon.db");
    mkdirSync(join(linkedWorktree, ".trekoon"), { recursive: true });
    writeFileSync(legacyDatabaseFile, "legacy shell state", "utf8");
    const sharedDatabaseFile = resolveStoragePaths(linkedWorktree).databaseFile;

    const result = await executeShell(parseInvocation(["--help", "--toon"], { stdoutIsTTY: false }), linkedWorktree);

    expect(result.ok).toBeTrue();
    const meta = result.meta as {
      storageRootDiagnostics?: {
        legacyStateDetected: boolean;
        recoveryStatus: string;
        autoMigratedLegacyState: boolean;
        importedFromLegacyDatabase: string | null;
        legacyDatabaseFiles: string[];
        backupFiles: string[];
      };
    };

    expect(meta.storageRootDiagnostics?.legacyStateDetected).toBeTrue();
    expect(meta.storageRootDiagnostics?.recoveryStatus).toBe("safe_auto_migrate");
    expect(meta.storageRootDiagnostics?.autoMigratedLegacyState).toBeFalse();
    expect(meta.storageRootDiagnostics?.importedFromLegacyDatabase).toBeNull();
    expect(meta.storageRootDiagnostics?.legacyDatabaseFiles).toEqual([realpathSync(legacyDatabaseFile)]);
    expect(meta.storageRootDiagnostics?.backupFiles).toEqual([]);
    expect(existsSync(sharedDatabaseFile)).toBeFalse();
    expect(existsSync(`${legacyDatabaseFile}.pre-shared-import.bak`)).toBeFalse();
  });

  test("unknown command diagnostics stay read-only", async (): Promise<void> => {
    const workspace = createWorkspace();
    createCommittedGitRepository(workspace);
    const linkedWorktree = createWorkspace();

    execFileSync("git", ["worktree", "add", "-b", "shell-unknown-readonly", linkedWorktree, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });

    const legacyDatabaseFile = join(linkedWorktree, ".trekoon", "trekoon.db");
    mkdirSync(join(linkedWorktree, ".trekoon"), { recursive: true });
    writeFileSync(legacyDatabaseFile, "legacy shell state", "utf8");
    const sharedDatabaseFile = resolveStoragePaths(linkedWorktree).databaseFile;

    const result = await executeShell(parseInvocation(["unknown", "--toon"], { stdoutIsTTY: false }), linkedWorktree);

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("unknown_command");
    const meta = result.meta as {
      storageRootDiagnostics?: {
        legacyStateDetected: boolean;
        recoveryStatus: string;
        autoMigratedLegacyState: boolean;
        importedFromLegacyDatabase: string | null;
        backupFiles: string[];
      };
    };

    expect(meta.storageRootDiagnostics?.legacyStateDetected).toBeTrue();
    expect(meta.storageRootDiagnostics?.recoveryStatus).toBe("safe_auto_migrate");
    expect(meta.storageRootDiagnostics?.autoMigratedLegacyState).toBeFalse();
    expect(meta.storageRootDiagnostics?.importedFromLegacyDatabase).toBeNull();
    expect(meta.storageRootDiagnostics?.backupFiles).toEqual([]);
    expect(existsSync(sharedDatabaseFile)).toBeFalse();
    expect(existsSync(`${legacyDatabaseFile}.pre-shared-import.bak`)).toBeFalse();
  });

  test("init meta reflects automatic legacy migration results", async (): Promise<void> => {
    const workspace = createWorkspace();
    createCommittedGitRepository(workspace);
    const linkedWorktree = createWorkspace();

    execFileSync("git", ["worktree", "add", "-b", "shell-init-auto-migrate", linkedWorktree, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });

    const legacyDatabaseFile = createLegacyDatabaseFile(linkedWorktree, "cli-auto-migrate");
    const sharedDatabaseFile = resolveStoragePaths(linkedWorktree).databaseFile;

    const result = await executeShell(parseInvocation(["init", "--toon"], { stdoutIsTTY: false }), linkedWorktree);

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("init");

    const data = result.data as {
      recoveryStatus: string;
      legacyStateDetected: boolean;
      recoveryRequired: boolean;
      legacyDatabaseFiles: string[];
      backupFiles: string[];
      autoMigratedLegacyState: boolean;
      importedFromLegacyDatabase: string | null;
      operatorAction: string;
    };
    const meta = result.meta as {
      storageRootDiagnostics?: {
        recoveryStatus: string;
        legacyStateDetected: boolean;
        recoveryRequired: boolean;
        legacyDatabaseFiles: string[];
        backupFiles: string[];
        autoMigratedLegacyState: boolean;
        importedFromLegacyDatabase: string | null;
        operatorAction: string;
      };
    };

    expect(existsSync(sharedDatabaseFile)).toBeTrue();
    expect(data.recoveryStatus).toBe("safe_auto_migrate");
    expect(data.legacyStateDetected).toBeTrue();
    expect(data.recoveryRequired).toBeFalse();
    expect(data.legacyDatabaseFiles).toEqual([legacyDatabaseFile]);
    expect(data.backupFiles).toHaveLength(1);
    expect(data.autoMigratedLegacyState).toBeTrue();
    expect(data.importedFromLegacyDatabase).toBe(legacyDatabaseFile);
    expect(data.operatorAction).toContain("Imported legacy worktree database into shared storage");

    expect(meta.storageRootDiagnostics).toEqual({
      ...meta.storageRootDiagnostics,
      recoveryStatus: data.recoveryStatus,
      legacyStateDetected: data.legacyStateDetected,
      recoveryRequired: data.recoveryRequired,
      legacyDatabaseFiles: data.legacyDatabaseFiles,
      backupFiles: data.backupFiles,
      autoMigratedLegacyState: data.autoMigratedLegacyState,
      importedFromLegacyDatabase: data.importedFromLegacyDatabase,
      operatorAction: data.operatorAction,
    });
    expect(meta.storageRootDiagnostics?.backupFiles).toHaveLength(1);
    expect(existsSync(meta.storageRootDiagnostics?.backupFiles[0] ?? "")).toBeTrue();
  });

  test("returns shared wipe scope data without parsing text", async (): Promise<void> => {
    const workspace = createWorkspace();
    createCommittedGitRepository(workspace);
    const linkedWorktree = createWorkspace();

    execFileSync("git", ["worktree", "add", "-b", "shell-wipe-scope", linkedWorktree, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });

    const result = await executeShell(parseInvocation(["wipe"], { stdoutIsTTY: false }), linkedWorktree);
    const sharedPaths = resolveStoragePaths(linkedWorktree);

    expect(result.ok).toBeFalse();
    expect(result.command).toBe("wipe");
    expect(result.error?.code).toBe("confirmation_required");
    expect(result.data).toEqual({
      confirmed: false,
      storageDir: sharedPaths.storageDir,
      worktreeRoot: sharedPaths.worktreeRoot,
      sharedStorageRoot: sharedPaths.sharedStorageRoot,
      repoScoped: true,
    });
  });
});
