import { chmodSync, existsSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { closeCachedDatabases } from "../storage/database";
import { resolveStoragePaths } from "../storage/path";

import { executeShell, parseInvocation, renderShellResult } from "./cli-shell";

/**
 * Daemon spike (experimental).
 *
 * Runs the trekoon CLI inside a long-lived Bun process listening on a Unix
 * domain socket. Clients submit `{argv, cwd}` payloads; the server runs
 * the same `executeShell` pipeline as the one-shot CLI and returns
 * `{stdout, stderr, exitCode}`.
 *
 * Environment variables are intentionally NOT part of the request contract.
 * The daemon process owns its own environment (set at `trekoon serve`
 * startup). Forwarding the client environment would (a) leak secrets across
 * the socket, (b) require the server to apply them, which it does not, and
 * (c) muddy the equivalence claim with the one-shot CLI. Per-call envs are
 * not supported — narrow the equivalence claim instead.
 *
 * Status: NOT the default path. Activated via `TREKOON_DAEMON=1` or the
 * `--daemon` flag. The one-shot CLI behavior is unchanged when the daemon is
 * unused or unreachable.
 */

export interface DaemonRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface DaemonResponse {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const REQUEST_TERMINATOR = "\n";
const MAX_REQUEST_BYTES = 1_000_000;

/**
 * Resolve the canonical Unix socket path for the given working directory.
 * The socket lives next to the SQLite database under `.trekoon/`.
 */
export function resolveDaemonSocketPath(cwd: string = process.cwd()): string {
  const paths = resolveStoragePaths(cwd);
  return `${paths.storageDir}/daemon.sock`;
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Execute a single daemon request through the in-process CLI shell.
 * Exported for direct unit testing without a socket round-trip.
 */
export async function executeDaemonRequest(request: DaemonRequest): Promise<DaemonResponse> {
  const argv: readonly string[] = request.argv;
  const cwd: string = request.cwd;
  const parsed = parseInvocation(argv, { stdoutIsTTY: false });

  try {
    const result = await executeShell(parsed, cwd);
    const rendered: string = renderShellResult(result, parsed.mode, parsed.compatibilityMode, {
      compact: parsed.compact,
    });

    if (result.ok) {
      return {
        stdout: `${rendered}\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    return {
      stdout: "",
      stderr: `${rendered}\n`,
      exitCode: 1,
    };
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.stack ?? error.message : String(error);
    return {
      stdout: "",
      stderr: `Daemon dispatch failure: ${message}\n`,
      exitCode: 1,
    };
  }
}

export interface DaemonServerHandle {
  readonly socketPath: string;
  readonly server: Server;
  close(): Promise<void>;
}

export interface StartDaemonOptions {
  readonly socketPath?: string;
  readonly cwd?: string;
  /** Suppress stdout banner; used by tests. */
  readonly silent?: boolean;
}

/**
 * Start the daemon server. Binds the Unix socket with mode 0o600 and ensures
 * the parent directory has mode 0o700. Returns a handle for graceful
 * shutdown. The CLI dispatch is run via `executeDaemonRequest`.
 */
export async function startDaemonServer(options: StartDaemonOptions = {}): Promise<DaemonServerHandle> {
  // Flip the in-process DB cache flag so subsequent openTrekoonDatabase calls
  // reuse a held-open connection. The default one-shot CLI never sets this.
  process.env.TREKOON_DAEMON_INPROCESS = "1";

  const cwd: string = options.cwd ?? process.cwd();
  const socketPath: string = options.socketPath ?? resolveDaemonSocketPath(cwd);
  const socketDir: string = dirname(socketPath);

  if (!existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  }
  // Tighten parent dir perms even if it pre-existed.
  try {
    chmodSync(socketDir, 0o700);
  } catch {
    // best effort; not all filesystems honour this
  }

  // Stale socket from a previous crashed run.
  safeUnlink(socketPath);

  const server: Server = createServer((socket: Socket): void => {
    let buffer = "";
    let aborted = false;

    socket.setEncoding("utf8");

    socket.on("data", (chunk: string): void => {
      if (aborted) {
        return;
      }
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        aborted = true;
        socket.write(
          `${JSON.stringify({
            stdout: "",
            stderr: "Daemon request exceeded max bytes\n",
            exitCode: 1,
          })}\n`,
        );
        socket.end();
        return;
      }

      const terminatorIndex: number = buffer.indexOf(REQUEST_TERMINATOR);
      if (terminatorIndex < 0) {
        return;
      }

      aborted = true;
      const payload: string = buffer.slice(0, terminatorIndex);
      buffer = "";

      void handlePayload(payload, socket);
    });

    socket.on("error", (): void => {
      // Ignore transport errors; the client either retries or the daemon stays up.
    });
  });

  // Tighten the umask BEFORE server.listen() so the socket inode is created
  // with mode 0o600 from inception. This closes the TOCTOU window between the
  // bind() syscall and the post-listen chmodSync. The chmodSync below remains
  // as a defence-in-depth fallback for filesystems where umask is ignored at
  // socket creation (some network FS / overlay FS edge cases).
  const previousUmask: number = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject): void => {
      const onError = (error: Error): void => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
  } finally {
    process.umask(previousUmask);
  }

  // Defence-in-depth: re-assert owner-only mode after listen succeeds.
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    // best effort
  }

  if (!options.silent) {
    process.stdout.write(`trekoon daemon listening on ${socketPath}\n`);
  }

  const handle: DaemonServerHandle = {
    socketPath,
    server,
    close: (): Promise<void> =>
      new Promise<void>((resolve): void => {
        server.close((): void => {
          safeUnlink(socketPath);
          closeCachedDatabases();
          delete process.env.TREKOON_DAEMON_INPROCESS;
          resolve();
        });
      }),
  };

  return handle;
}

async function handlePayload(payload: string, socket: Socket): Promise<void> {
  let response: DaemonResponse;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isDaemonRequest(parsed)) {
      response = {
        stdout: "",
        stderr: "Daemon: invalid request payload\n",
        exitCode: 1,
      };
    } else {
      response = await executeDaemonRequest(parsed);
    }
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    response = {
      stdout: "",
      stderr: `Daemon: payload parse error: ${message}\n`,
      exitCode: 1,
    };
  }

  const serialized: string = `${JSON.stringify(response)}\n`;
  socket.write(serialized, (): void => {
    socket.end();
  });
}

function isDaemonRequest(value: unknown): value is DaemonRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.argv)) {
    return false;
  }
  if (!candidate.argv.every((entry): boolean => typeof entry === "string")) {
    return false;
  }
  if (typeof candidate.cwd !== "string") {
    return false;
  }
  // env is no longer part of the request contract; ignore it if present from
  // older clients rather than failing the request.
  return true;
}

export interface DaemonClientResult extends DaemonResponse {
  readonly transport: "daemon";
}

/**
 * Send a single request to a running daemon. Resolves with the parsed
 * response. Throws on transport-level failures (the caller falls back to the
 * in-process path on throw).
 */
export async function sendDaemonRequest(
  socketPath: string,
  request: DaemonRequest,
  timeoutMs: number = 30_000,
): Promise<DaemonClientResult> {
  return new Promise<DaemonClientResult>((resolve, reject): void => {
    const socket: Socket = connect(socketPath);
    let buffer = "";
    let settled = false;

    const timer = setTimeout((): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy(new Error("daemon request timeout"));
      reject(new Error(`daemon request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.setEncoding("utf8");

    socket.on("connect", (): void => {
      socket.write(`${JSON.stringify(request)}${REQUEST_TERMINATOR}`);
    });

    socket.on("data", (chunk: string): void => {
      buffer += chunk;
    });

    socket.on("error", (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    socket.on("end", (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        const trimmed: string = buffer.trim();
        const parsed: unknown = JSON.parse(trimmed);
        if (!isDaemonResponse(parsed)) {
          reject(new Error("daemon returned malformed response"));
          return;
        }
        resolve({ ...parsed, transport: "daemon" });
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function isDaemonResponse(value: unknown): value is DaemonResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.stdout === "string"
    && typeof candidate.stderr === "string"
    && typeof candidate.exitCode === "number"
  );
}

/**
 * Heuristic check that a daemon socket is live: file exists, looks like a
 * socket, and its directory is on the local filesystem. We do NOT round-trip
 * a ping here — the client retries the real request and falls back on error.
 */
export function isDaemonSocketPresent(socketPath: string): boolean {
  try {
    const stats = statSync(socketPath);
    return stats.isSocket();
  } catch {
    return false;
  }
}

/**
 * Run the daemon in the foreground until SIGINT/SIGTERM. Used by
 * `trekoon serve`.
 */
export async function runDaemonForeground(options: StartDaemonOptions = {}): Promise<void> {
  const handle = await startDaemonServer(options);

  if (!options.silent) {
    process.stdout.write("Press Ctrl-C to stop. (experimental spike)\n");
  }

  await new Promise<void>((resolve): void => {
    const shutdown = (): void => {
      void handle.close().then((): void => {
        resolve();
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

/**
 * Try to dispatch the invocation through the daemon. Returns the rendered
 * response on success, or `null` when no daemon is reachable so the caller
 * can fall back to in-process dispatch.
 */
export async function tryDaemonDispatch(argv: readonly string[]): Promise<DaemonClientResult | null> {
  const cwd: string = process.cwd();
  const socketPath: string = resolveDaemonSocketPath(cwd);
  if (!isDaemonSocketPresent(socketPath)) {
    return null;
  }

  try {
    // The daemon owns its own environment (set at `trekoon serve` startup);
    // client env is deliberately NOT forwarded over the socket.
    return await sendDaemonRequest(socketPath, { argv: [...argv], cwd });
  } catch {
    return null;
  }
}
