import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { executeShell, parseInvocation } from "../../src/runtime/cli-shell";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-shell-"));
  tempDirs.push(workspace);
  return workspace;
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
});
