import { chmodSync, existsSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { redactStack, safeErrorMessage } from "../commands/error-utils";
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
/** Maximum bytes buffered across all open server sockets at once. */
const MAX_TOTAL_BUFFERED_BYTES = 8 * MAX_REQUEST_BYTES;
/** Default cap on concurrent open server-side sockets. */
const DEFAULT_MAX_CONNECTIONS = 32;
/** Idle/incomplete-request timeout for a server-side socket. */
const SERVER_SOCKET_IDLE_MS = 5_000;
const OWNER_ONLY_MASK = 0o077;

/**
 * Pre-write transport failure: the daemon socket was unreachable or the
 * request never made it onto the wire. Safe to fall back to in-process
 * dispatch — no server-side mutation could have run.
 */
export class PreWriteTransportError extends Error {
  public override readonly cause: unknown;
  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PreWriteTransportError";
    this.cause = cause;
  }
}

/**
 * Post-write transport failure: the request bytes were already flushed to
 * the daemon socket when the failure occurred. The server may have
 * committed the mutation. The CLI must NOT silently re-run the command in
 * process — exit non-zero so the caller can decide.
 */
export class PostWriteError extends Error {
  public override readonly cause: unknown;
  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PostWriteError";
    this.cause = cause;
  }
}

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

function isPreWriteTransportCode(code: string | undefined): boolean {
  return (
    code === "ENOENT"
    || code === "ECONNREFUSED"
    || code === "EACCES"
    || code === "EPERM"
    || code === "ETIMEDOUT"
  );
}

function debugLog(prefix: string, payload: unknown): void {
  if (process.env.TREKOON_DEBUG === "1") {
    // eslint-disable-next-line no-console
    console.error(prefix, payload);
    return;
  }
  if (payload instanceof Error) {
    const message: string = safeErrorMessage(payload, "unknown error");
    // eslint-disable-next-line no-console
    console.error(`${prefix} ${message}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(prefix);
}

function formatMode(mode: number): string {
  // eslint-disable-next-line no-bitwise
  return `0o${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function assertOwnerOnlyMode(path: string, label: string): void {
  const stats = statSync(path);
  // eslint-disable-next-line no-bitwise
  if ((stats.mode & OWNER_ONLY_MASK) !== 0) {
    throw new Error(`${label} at ${path} must be owner-only; got ${formatMode(stats.mode)}`);
  }
}

export function __assertOwnerOnlyModeForTests(path: string, label: string): void {
  assertOwnerOnlyMode(path, label);
}

function isPathWithin(candidatePath: string, rootPath: string): boolean {
  const candidate: string = resolve(candidatePath);
  const root: string = resolve(rootPath);
  const pathToCandidate: string = relative(root, candidate);
  return pathToCandidate === "" || (!pathToCandidate.startsWith("..") && !isAbsolute(pathToCandidate));
}

function isAllowedRequestCwd(cwd: string, allowedRoots: readonly string[]): boolean {
  return allowedRoots.some((root: string): boolean => isPathWithin(cwd, root));
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
    // Never include the stack in the response envelope: stacks contain
    // absolute filesystem paths and may carry secret-bearing error text.
    // The stack is still surfaced locally on the daemon's stderr for
    // operator-side debugging, with secrets redacted unless TREKOON_DEBUG=1.
    if (error instanceof Error && typeof error.stack === "string") {
      const stack: string = process.env.TREKOON_DEBUG === "1"
        ? error.stack
        : redactStack(error.stack);
      // eslint-disable-next-line no-console
      console.error("[trekoon daemon] dispatch failure:", stack);
    } else {
      // eslint-disable-next-line no-console
      console.error("[trekoon daemon] dispatch failure:", error);
    }
    const sanitized: string = safeErrorMessage(error, "unknown error");
    return {
      stdout: "",
      stderr: `Daemon dispatch failure: ${sanitized}\n`,
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
  /** Override the default concurrent connection cap. */
  readonly maxConnections?: number;
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
  const maxConnections: number = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const daemonStoragePaths = resolveStoragePaths(cwd);
  const allowedRequestRoots: readonly string[] = [
    daemonStoragePaths.worktreeRoot,
    daemonStoragePaths.storageDir,
  ];

  if (!existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  }
  // Tighten parent dir perms even if it pre-existed.
  chmodSync(socketDir, 0o700);
  assertOwnerOnlyMode(socketDir, "daemon socket directory");

  // Stale socket from a previous crashed run.
  safeUnlink(socketPath);

  // Tracks open server-side sockets and the bytes each one currently has
  // buffered. Used to enforce both the per-server connection cap and a
  // global upper bound on memory pressure across all in-flight requests.
  const liveSockets: Set<Socket> = new Set<Socket>();
  const processingSockets: Set<Socket> = new Set<Socket>();
  const inFlightRequests: Set<Promise<void>> = new Set<Promise<void>>();
  let totalBufferedBytes = 0;

  const server: Server = createServer((socket: Socket): void => {
    if (liveSockets.size >= maxConnections) {
      const busyEnvelope: string = `${JSON.stringify({
        stdout: "",
        stderr: "Daemon: daemon_busy (too many concurrent connections)\n",
        exitCode: 1,
      })}\n`;
      socket.write(busyEnvelope, (): void => {
        socket.end();
      });
      return;
    }

    liveSockets.add(socket);
    let buffer = "";
    let aborted = false;
    let perSocketBytes = 0;

    socket.setEncoding("utf8");
    // Reject sockets that connect, never send a terminator, and sit idle —
    // these accumulate file descriptors and buffer memory otherwise.
    socket.setTimeout(SERVER_SOCKET_IDLE_MS);

    const releaseBuffered = (): void => {
      totalBufferedBytes -= perSocketBytes;
      perSocketBytes = 0;
    };

    const onClose = (): void => {
      liveSockets.delete(socket);
      releaseBuffered();
    };

    socket.on("timeout", (): void => {
      if (aborted) {
        return;
      }
      aborted = true;
      try {
        socket.write(
          `${JSON.stringify({
            stdout: "",
            stderr: "Daemon: incomplete request (socket idle timeout)\n",
            exitCode: 1,
          })}\n`,
        );
      } catch {
        // best effort
      }
      socket.end();
      socket.destroy();
    });

    socket.on("data", (chunk: string): void => {
      if (aborted) {
        return;
      }
      const chunkBytes: number = Buffer.byteLength(chunk, "utf8");
      buffer += chunk;
      perSocketBytes += chunkBytes;
      totalBufferedBytes += chunkBytes;

      if (buffer.length > MAX_REQUEST_BYTES || totalBufferedBytes > MAX_TOTAL_BUFFERED_BYTES) {
        aborted = true;
        const reason: string = totalBufferedBytes > MAX_TOTAL_BUFFERED_BYTES
          ? "daemon_busy (server buffer pressure)"
          : "request exceeded max bytes";
        try {
          socket.write(
            `${JSON.stringify({
              stdout: "",
              stderr: `Daemon: ${reason}\n`,
              exitCode: 1,
            })}\n`,
          );
        } catch {
          // best effort
        }
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
      releaseBuffered();
      // Once we have a complete request the idle timer is no longer
      // meaningful; the dispatcher controls the lifetime from here.
      socket.setTimeout(0);

      processingSockets.add(socket);
      const requestPromise = handlePayload(payload, socket, allowedRequestRoots).finally((): void => {
        processingSockets.delete(socket);
        inFlightRequests.delete(requestPromise);
      });
      inFlightRequests.add(requestPromise);
    });

    socket.on("error", (error: Error): void => {
      // Surface as a debug-level redacted log; never as a bare empty handler.
      debugLog("[trekoon daemon] socket error:", error);
    });

    socket.on("close", onClose);
  });

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

  // Owner-only mode is enforced by the pre-created 0o700 parent directory
  // plus this post-listen chmod. We deliberately do NOT wrap server.listen
  // in a process.umask() override: that mutates global process state for
  // every concurrent operation and was the source of an audit-flagged
  // race when other code allocates fds during startup.
  try {
    chmodSync(socketPath, 0o600);
    assertOwnerOnlyMode(socketPath, "daemon socket");
  } catch (error: unknown) {
    await new Promise<void>((resolve): void => {
      server.close((): void => resolve());
    });
    safeUnlink(socketPath);
    throw error;
  }

  if (!options.silent) {
    process.stdout.write(`trekoon daemon listening on ${socketPath}\n`);
  }

  const handle: DaemonServerHandle = {
    socketPath,
    server,
    close: async (): Promise<void> => {
      const serverClosed = new Promise<void>((resolve): void => {
        server.close((): void => resolve());
      });
      // Force-close idle sockets so server.close() resolves promptly during
      // test teardown, but let in-flight dispatches finish before DB shutdown.
      for (const sock of liveSockets) {
        if (processingSockets.has(sock)) {
          continue;
        }
        try {
          sock.destroy();
        } catch {
          // best effort
        }
      }
      await Promise.allSettled([...inFlightRequests]);
      for (const sock of liveSockets) {
        try {
          sock.destroy();
        } catch {
          // best effort
        }
      }
      await serverClosed;
      liveSockets.clear();
      processingSockets.clear();
      totalBufferedBytes = 0;
      safeUnlink(socketPath);
      closeCachedDatabases();
      delete process.env.TREKOON_DAEMON_INPROCESS;
    },
  };

  return handle;
}

async function handlePayload(
  payload: string,
  socket: Socket,
  allowedRequestRoots: readonly string[],
): Promise<void> {
  let response: DaemonResponse;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isDaemonRequest(parsed)) {
      response = {
        stdout: "",
        stderr: "Daemon: invalid request payload\n",
        exitCode: 1,
      };
    } else if (!isAllowedRequestCwd(parsed.cwd, allowedRequestRoots)) {
      response = {
        stdout: "",
        stderr: "Daemon: request cwd is outside the daemon worktree/storage scope\n",
        exitCode: 1,
      };
    } else {
      response = await executeDaemonRequest(parsed);
    }
  } catch (error: unknown) {
    // Sanitize and never include a stack — the wire envelope must not leak
    // filesystem paths or secret-bearing error text. The stack stays on the
    // daemon's local stderr for operator debugging, redacted unless
    // TREKOON_DEBUG=1 explicitly opts in to raw output.
    if (error instanceof Error && typeof error.stack === "string") {
      const stack: string = process.env.TREKOON_DEBUG === "1"
        ? error.stack
        : redactStack(error.stack);
      // eslint-disable-next-line no-console
      console.error("[trekoon daemon] payload parse error:", stack);
    }
    const sanitized: string = safeErrorMessage(error, "invalid payload");
    response = {
      stdout: "",
      stderr: `Daemon: payload parse error: ${sanitized}\n`,
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
 * response. Throws `PreWriteTransportError` for connect-time failures (the
 * caller may safely fall back to in-process dispatch) and `PostWriteError`
 * once the request bytes have been flushed (the caller MUST surface the
 * failure rather than retrying — the daemon may have already committed).
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
    // Flips to true the moment the request bytes are flushed to the kernel
    // socket buffer. Any subsequent error/timeout MUST surface as
    // PostWriteError because the daemon may have already executed the
    // mutation.
    let writeAttempted = false;

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // best effort
      }
      if (writeAttempted) {
        const cause: unknown = error;
        const message: string = error instanceof Error ? error.message : String(error);
        reject(new PostWriteError(`daemon may have committed; do not retry: ${message}`, cause));
        return;
      }
      if (error instanceof Error) {
        const code: string | undefined = (error as NodeJS.ErrnoException).code;
        if (isPreWriteTransportCode(code)) {
          reject(new PreWriteTransportError(error.message, error));
          return;
        }
        reject(new PreWriteTransportError(error.message, error));
        return;
      }
      reject(new PreWriteTransportError(String(error), error));
    };

    const timer = setTimeout((): void => {
      if (settled) {
        return;
      }
      // Build the timeout error before we settle so the post/pre-write
      // classifier picks up the current `postWrite` flag.
      const timeoutError = new Error(`daemon request timed out after ${timeoutMs}ms`);
      fail(timeoutError);
    }, timeoutMs);

    socket.setEncoding("utf8");

    socket.on("connect", (): void => {
      const wireBytes: string = `${JSON.stringify(request)}${REQUEST_TERMINATOR}`;
      writeAttempted = true;
      socket.write(wireBytes, (writeError?: Error | null): void => {
        if (writeError) {
          fail(writeError);
          return;
        }
        // Callback confirmation is intentionally retained as a second signal
        // for future diagnostics; classification flips synchronously before
        // socket.write can return so write-then-error races are post-write.
        writeAttempted = true;
      });
    });

    socket.on("data", (chunk: string): void => {
      buffer += chunk;
    });

    socket.on("error", (error: Error): void => {
      fail(error);
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
          // We did receive a (malformed) response, so the request was
          // post-write — surface as PostWriteError so the CLI does not
          // silently re-run.
          reject(new PostWriteError("daemon returned malformed response"));
          return;
        }
        resolve({ ...parsed, transport: "daemon" });
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        reject(new PostWriteError(`daemon response parse error: ${message}`, error));
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
 * response on success, or `null` ONLY when the failure happened pre-write
 * (no bytes left this process). Post-write failures are rethrown as
 * `PostWriteError` so the caller can exit non-zero rather than
 * re-executing in-process — the daemon may have committed.
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
  } catch (error: unknown) {
    if (error instanceof PreWriteTransportError) {
      return null;
    }
    // PostWriteError or any unclassified failure must surface so src/index.ts
    // can refuse to silently re-run the command.
    throw error;
  }
}
