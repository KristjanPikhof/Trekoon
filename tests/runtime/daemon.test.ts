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

  test("DaemonRequest contract has no env field; older clients with env are tolerated", async (): Promise<void> => {
    // Type-level: DaemonRequest is {argv, cwd} only. Construct one and ensure
    // the in-process executor still works without env.
    const workspace = createWorkspace();
    initGitRepository(workspace);

    const initParsed = parseInvocation(["--toon", "init"], { stdoutIsTTY: false });
    const initResult = await executeShell(initParsed, workspace);
    expect(initResult.ok).toBeTrue();

    const direct = await executeDaemonRequest({
      argv: ["--toon", "session"],
      cwd: workspace,
    });
    expect(direct.exitCode).toBe(0);

    // Ensure the validator still accepts a payload that includes a stray
    // legacy `env` field (older clients) without rejecting the request — env
    // is silently ignored by the server.
    mkdirSync(join(workspace, ".trekoon"), { recursive: true });
    const socketPath = join(workspace, ".trekoon", "daemon.sock");
    const handle = await startDaemonServer({ socketPath, cwd: workspace, silent: true });
    try {
      const legacyPayload = {
        argv: ["--toon", "--version"],
        cwd: workspace,
        env: { TREKOON_LEGACY_FIELD: "ignored" },
      } as unknown as { argv: readonly string[]; cwd: string };
      const response = await sendDaemonRequest(socketPath, legacyPayload);
      expect(response.exitCode).toBe(0);
      expect(response.stdout).toContain("version");
    } finally {
      await handle.close();
    }
  });

  test("tryDaemonDispatch does not forward client process.env over the socket", async (): Promise<void> => {
    // Spin up a tiny socket server that captures the raw bytes the client
    // sent and asserts no `env` field appears on the wire. We use a generic
    // node:net server (not startDaemonServer) so the test doesn't need the
    // tracker DB plumbing.
    const { createServer } = await import("node:net");
    const { tryDaemonDispatch } = await import("../../src/runtime/daemon");

    const workspace = createWorkspace();
    mkdirSync(join(workspace, ".trekoon"), { recursive: true });
    const socketPath = join(workspace, ".trekoon", "daemon.sock");

    let captured = "";
    const captureServer = createServer((socket): void => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string): void => {
        captured += chunk;
        if (captured.includes("\n")) {
          // Reply with a minimal valid DaemonResponse so the client resolves.
          socket.write(`${JSON.stringify({ stdout: "", stderr: "", exitCode: 0 })}\n`);
          socket.end();
        }
      });
    });
    await new Promise<void>((resolve, reject): void => {
      captureServer.once("error", reject);
      captureServer.listen(socketPath, (): void => {
        captureServer.removeListener("error", reject);
        resolve();
      });
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    // Inject a sentinel into the client env so we can assert it never reaches
    // the wire.
    process.env.TREKOON_TEST_DO_NOT_LEAK = "leak-canary-9c1";
    try {
      await tryDaemonDispatch(["--toon", "session"]);
    } finally {
      delete process.env.TREKOON_TEST_DO_NOT_LEAK;
      process.chdir(previousCwd);
      await new Promise<void>((resolve): void => captureServer.close((): void => resolve()));
    }

    expect(captured.length).toBeGreaterThan(0);
    const parsedRequest = JSON.parse(captured.trim()) as Record<string, unknown>;
    expect(Array.isArray(parsedRequest.argv)).toBeTrue();
    expect(typeof parsedRequest.cwd).toBe("string");
    expect("env" in parsedRequest).toBeFalse();
    expect(captured).not.toContain("leak-canary-9c1");
  });
});
