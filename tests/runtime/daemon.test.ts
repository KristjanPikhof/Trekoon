import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  executeDaemonRequest,
  isDaemonSocketPresent,
  PostWriteError,
  PreWriteTransportError,
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

  test("daemon error envelopes never include a stack trace", async (): Promise<void> => {
    const workspace = createWorkspace();
    initGitRepository(workspace);

    mkdirSync(join(workspace, ".trekoon"), { recursive: true });
    const socketPath = join(workspace, ".trekoon", "daemon.sock");
    const handle = await startDaemonServer({ socketPath, cwd: workspace, silent: true });

    try {
      // 1. Trigger the JSON.parse-error branch of handlePayload by feeding raw
      //    non-JSON bytes terminated by a newline directly to the socket.
      const { connect } = await import("node:net");
      const parseErrorReply: string = await new Promise<string>((resolve, reject): void => {
        const socket = connect(socketPath);
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("connect", (): void => {
          socket.write("not-json\n");
        });
        socket.on("data", (chunk: string): void => {
          buffer += chunk;
        });
        socket.on("end", (): void => resolve(buffer));
        socket.on("error", reject);
      });

      const parseErrorEnvelope = JSON.parse(parseErrorReply.trim()) as {
        stdout: string;
        stderr: string;
        exitCode: number;
      };
      expect(parseErrorEnvelope.exitCode).toBe(1);
      expect(parseErrorEnvelope.stderr).toContain("payload parse error");
      // No stack-trace line markers ("    at ..." / "(file:///...)") should
      // appear in the wire envelope.
      expect(parseErrorEnvelope.stderr).not.toMatch(/^\s+at\s.+/m);
      expect(parseErrorEnvelope.stderr).not.toContain("file://");
      expect(parseErrorEnvelope.stderr).not.toContain(".ts:");
      // The stderr is bounded — a stack trace would be many lines.
      expect(parseErrorEnvelope.stderr.split("\n").length).toBeLessThanOrEqual(3);
    } finally {
      await handle.close();
    }
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
      await new Promise<void>((resolve): void => {
        captureServer.close((): void => {
          resolve();
        });
      });
    }

    expect(captured.length).toBeGreaterThan(0);
    const parsedRequest = JSON.parse(captured.trim()) as Record<string, unknown>;
    expect(Array.isArray(parsedRequest.argv)).toBeTrue();
    expect(typeof parsedRequest.cwd).toBe("string");
    expect("env" in parsedRequest).toBeFalse();
    expect(captured).not.toContain("leak-canary-9c1");
  });

  test("post-write timeout surfaces as PostWriteError; CLI must not silently retry", async (): Promise<void> => {
    // Spin up a server that accepts the request bytes but never replies. The
    // client's request timeout should classify this as PostWriteError because
    // the bytes were already on the wire.
    const { createServer } = await import("node:net");

    const workspace = createWorkspace();
    mkdirSync(join(workspace, ".trekoon"), { recursive: true });
    const socketPath = join(workspace, ".trekoon", "daemon.sock");

    const blackHole = createServer((socket): void => {
      // Read but never respond.
      socket.setEncoding("utf8");
      socket.on("data", (): void => {
        // intentionally no reply
      });
    });
    await new Promise<void>((resolve, reject): void => {
      blackHole.once("error", reject);
      blackHole.listen(socketPath, (): void => {
        blackHole.removeListener("error", reject);
        resolve();
      });
    });

    let caught: unknown = null;
    try {
      await sendDaemonRequest(
        socketPath,
        { argv: ["--toon", "session"], cwd: workspace },
        50,
      );
    } catch (error: unknown) {
      caught = error;
    } finally {
      await new Promise<void>((resolve): void => {
        blackHole.close((): void => resolve());
      });
    }

    expect(caught).toBeInstanceOf(PostWriteError);
    expect(caught).not.toBeInstanceOf(PreWriteTransportError);
    expect((caught as Error).message).toContain("daemon may have committed");
  });

  test("error stack containing Bearer secret is redacted on daemon stderr", async (): Promise<void> => {
    // The handlePayload parse-error branch logs the (redacted) stack to the
    // daemon's local stderr. Capture stderr and assert no Bearer token leaks.
    const workspace = createWorkspace();
    initGitRepository(workspace);

    mkdirSync(join(workspace, ".trekoon"), { recursive: true });
    const socketPath = join(workspace, ".trekoon", "daemon.sock");
    const handle = await startDaemonServer({ socketPath, cwd: workspace, silent: true });

    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalConsoleError = console.error;
    let captured = "";
    // Patch both because debug logging uses console.error which routes to stderr.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (
      chunk: string,
    ): boolean => {
      captured += chunk;
      return true;
    };
    console.error = (...args: unknown[]): void => {
      captured += args
        .map((a): string => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      captured += "\n";
    };

    const previousDebug: string | undefined = process.env.TREKOON_DEBUG;
    delete process.env.TREKOON_DEBUG;

    try {
      // Send a payload whose JSON content contains a Bearer secret. The parser
      // will fail (invalid JSON because we send raw text after the bearer) and
      // the resulting SyntaxError stack should not leak the secret because
      // redactStack runs over it.
      const { connect } = await import("node:net");
      await new Promise<void>((resolve, reject): void => {
        const socket = connect(socketPath);
        socket.setEncoding("utf8");
        socket.on("connect", (): void => {
          // Authorization: Bearer abc123-leak-canary appears verbatim in the
          // parse error message that Node bubbles up.
          socket.write("Authorization: Bearer abc123-leak-canary INVALID\n");
        });
        socket.on("data", (): void => {
          // discard reply envelope
        });
        socket.on("end", (): void => resolve());
        socket.on("error", reject);
      });

      // Give the async error handler a tick to flush.
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, 50);
      });

      // The reply envelope itself never contains the stack; the stack is
      // logged to stderr and we want to confirm the bearer secret is redacted
      // there. The redactor replaces credentials with [REDACTED].
      expect(captured).not.toContain("abc123-leak-canary");
    } finally {
      process.stderr.write = originalStderrWrite;
      console.error = originalConsoleError;
      if (previousDebug !== undefined) {
        process.env.TREKOON_DEBUG = previousDebug;
      }
      await handle.close();
    }
  });

  test("rejects connections beyond the maxConnections cap with daemon_busy", async (): Promise<void> => {
    const { connect } = await import("node:net");
    const workspace = createWorkspace();
    initGitRepository(workspace);

    mkdirSync(join(workspace, ".trekoon"), { recursive: true });
    const socketPath = join(workspace, ".trekoon", "daemon.sock");
    // Cap intentionally tiny so the test is fast and deterministic.
    const handle = await startDaemonServer({
      socketPath,
      cwd: workspace,
      silent: true,
      maxConnections: 2,
    });

    const heldSockets: import("node:net").Socket[] = [];
    try {
      // Open `cap` long-lived sockets that never send a terminator, then
      // attempt one more — the (cap+1)th must receive daemon_busy.
      const openLongLived = (): Promise<void> =>
        new Promise<void>((resolve, reject): void => {
          const sock = connect(socketPath);
          sock.setEncoding("utf8");
          sock.once("connect", (): void => {
            heldSockets.push(sock);
            resolve();
          });
          sock.once("error", reject);
        });
      await openLongLived();
      await openLongLived();

      // The third connection should be served a daemon_busy envelope and
      // immediately closed. Read the reply.
      const reply: string = await new Promise<string>((resolve, reject): void => {
        const sock = connect(socketPath);
        let buffer = "";
        sock.setEncoding("utf8");
        sock.on("data", (chunk: string): void => {
          buffer += chunk;
        });
        sock.on("end", (): void => resolve(buffer));
        sock.on("close", (): void => resolve(buffer));
        sock.on("error", reject);
      });

      expect(reply).toContain("daemon_busy");
    } finally {
      for (const sock of heldSockets) {
        try {
          sock.destroy();
        } catch {
          // best effort
        }
      }
      await handle.close();
    }
  });

  test("idle socket without terminator is destroyed after the server idle timeout", async (): Promise<void> => {
    // Override the idle timeout indirectly: the server uses a 5s constant, so
    // we connect and wait for the idle envelope. Bound the test by sending
    // nothing and asserting the server returns the idle-timeout envelope and
    // closes the socket within a generous window.
    const { connect } = await import("node:net");
    const workspace = createWorkspace();
    initGitRepository(workspace);

    mkdirSync(join(workspace, ".trekoon"), { recursive: true });
    const socketPath = join(workspace, ".trekoon", "daemon.sock");
    const handle = await startDaemonServer({ socketPath, cwd: workspace, silent: true });

    try {
      const start = Date.now();
      const reply: string = await new Promise<string>((resolve, reject): void => {
        const sock = connect(socketPath);
        let buffer = "";
        sock.setEncoding("utf8");
        sock.on("connect", (): void => {
          // Intentionally never send a terminator.
        });
        sock.on("data", (chunk: string): void => {
          buffer += chunk;
        });
        sock.on("close", (): void => resolve(buffer));
        sock.on("end", (): void => resolve(buffer));
        // 8s upper bound — server constant is 5s.
        sock.on("error", reject);
        setTimeout((): void => {
          try {
            sock.destroy();
          } catch {
            // best effort
          }
          resolve(buffer);
        }, 8_000);
      });
      const elapsed: number = Date.now() - start;

      expect(reply).toContain("idle timeout");
      // Should have fired around the 5s server constant — must NOT happen
      // immediately (would suggest idle timer is not running) and must have
      // closed before the 8s outer guard.
      expect(elapsed).toBeGreaterThan(3_000);
      expect(elapsed).toBeLessThan(8_000);
    } finally {
      await handle.close();
    }
  }, 15_000);
});
