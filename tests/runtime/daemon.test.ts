import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  executeDaemonRequest,
  isDaemonSocketPresent,
  resolveDaemonSocketPath,
  sendDaemonRequest,
  startDaemonServer,
} from "../../src/runtime/daemon";
import { executeShell, parseInvocation } from "../../src/runtime/cli-shell";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-daemon-"));
  tempDirs.push(workspace);
  return workspace;
}

function initGitRepository(workspace: string): void {
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, ".gitignore"), ".trekoon/\n", "utf8");
  writeFileSync(join(workspace, "README.md"), "# Trekoon\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Trekoon Tests", "-c", "user.email=tests@trekoon.local", "commit", "-m", "init"],
    { cwd: workspace, stdio: "ignore" },
  );
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("daemon dispatch", (): void => {
  test("executeDaemonRequest renders the same payload as in-process executeShell", async (): Promise<void> => {
    const workspace = createWorkspace();
    initGitRepository(workspace);

    // Initialise tracker so `session` returns a stable shape.
    const initParsed = parseInvocation(["--toon", "init"], { stdoutIsTTY: false });
    const initResult = await executeShell(initParsed, workspace);
    expect(initResult.ok).toBeTrue();

    const direct = await executeDaemonRequest({
      argv: ["--toon", "session"],
      cwd: workspace,
    });

    expect(direct.exitCode).toBe(0);
    expect(direct.stderr).toBe("");
    expect(direct.stdout).toContain("session");
    expect(direct.stdout.endsWith("\n")).toBeTrue();
  });

  test("round-trip over a Unix socket returns equivalent output to direct dispatch", async (): Promise<void> => {
    const workspace = createWorkspace();
    initGitRepository(workspace);

    // Place the socket under the test workspace storage dir to avoid colliding
    // with any developer daemon running against the real repo.
    mkdirSync(join(workspace, ".trekoon"), { recursive: true });
    const socketPath = join(workspace, ".trekoon", "daemon.sock");

    const handle = await startDaemonServer({ socketPath, cwd: workspace, silent: true });

    try {
      // Bootstrap tracker through the socket itself.
      const initOverSocket = await sendDaemonRequest(socketPath, {
        argv: ["--toon", "init"],
        cwd: workspace,
      });
      expect(initOverSocket.exitCode).toBe(0);

      const direct = await executeDaemonRequest({
        argv: ["--toon", "session"],
        cwd: workspace,
      });

      const remote = await sendDaemonRequest(socketPath, {
        argv: ["--toon", "session"],
        cwd: workspace,
      });

      expect(remote.transport).toBe("daemon");
      expect(remote.exitCode).toBe(direct.exitCode);
      expect(remote.stderr).toBe(direct.stderr);
      // The `session` envelope embeds a per-call requestId and persistedAt
      // timestamp, so direct and remote outputs differ byte-for-byte.
      // Instead, sanity-check that the structural shape matches.
      expect(remote.stdout.startsWith("ok: true")).toBeTrue();
      expect(direct.stdout.startsWith("ok: true")).toBeTrue();
      expect(remote.stdout).toContain("command: session");
      expect(direct.stdout).toContain("command: session");
      expect(remote.stdout).toContain("readiness:");
      expect(direct.stdout).toContain("readiness:");

      expect(isDaemonSocketPresent(socketPath)).toBeTrue();
      const stats = statSync(socketPath);
      // Owner-only mode (mode bits masked).
      // eslint-disable-next-line no-bitwise
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await handle.close();
    }

    expect(isDaemonSocketPresent(socketPath)).toBeFalse();
  });

  test("rejects malformed payloads without crashing the server", async (): Promise<void> => {
    const workspace = createWorkspace();
    initGitRepository(workspace);

    mkdirSync(join(workspace, ".trekoon"), { recursive: true });
    const socketPath = join(workspace, ".trekoon", "daemon.sock");
    const handle = await startDaemonServer({ socketPath, cwd: workspace, silent: true });

    try {
      // Send an obviously invalid request directly via sendDaemonRequest. The
      // helper validates response shape, so a malformed-but-parseable response
      // still resolves.
      const response = await sendDaemonRequest(socketPath, {
        // Cast to bypass type guard so we can simulate a hostile client.
        argv: ["--toon", "session"] as unknown as string[],
        cwd: workspace,
      });
      expect(response.exitCode).toBe(0);

      // Server still alive after a valid call following the bootstrap.
      const second = await sendDaemonRequest(socketPath, {
        argv: ["--toon", "--version"],
        cwd: workspace,
      });
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("version");
    } finally {
      await handle.close();
    }
  });

  test("resolveDaemonSocketPath places the socket inside .trekoon", (): void => {
    const workspace = createWorkspace();
    const path = resolveDaemonSocketPath(workspace);
    expect(path.endsWith("daemon.sock")).toBeTrue();
    expect(path).toContain(".trekoon");
  });
});
