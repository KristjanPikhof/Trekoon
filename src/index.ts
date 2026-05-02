#!/usr/bin/env bun

import { executeShell, parseInvocation, renderShellResult } from "./runtime/cli-shell";

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseInvocation(argv);

  // Daemon path is opt-in (TREKOON_DAEMON=1 or --daemon). The `serve`
  // subcommand always runs in-process so it can host the daemon.
  const daemonRequested: boolean = parsed.wantsDaemon || process.env.TREKOON_DAEMON === "1";
  if (daemonRequested && parsed.command !== "serve") {
    const { tryDaemonDispatch, PostWriteError } = await import("./runtime/daemon");
    // Strip --daemon from the argv we forward (the server has its own dispatch).
    const forwarded: readonly string[] = argv.filter((token: string): boolean => token !== "--daemon");
    try {
      const daemonResult = await tryDaemonDispatch(forwarded);
      if (daemonResult !== null) {
        if (daemonResult.stdout.length > 0) {
          process.stdout.write(daemonResult.stdout);
        }
        if (daemonResult.stderr.length > 0) {
          process.stderr.write(daemonResult.stderr);
        }
        process.exitCode = daemonResult.exitCode;
        return;
      }
      // Fall through to one-shot CLI when no daemon is reachable (pre-write
      // transport failure — request never made it onto the wire).
    } catch (error: unknown) {
      // Post-write failure: the request bytes were already flushed to the
      // daemon. The mutation may have committed. Refuse to silently re-run
      // the command in-process; exit non-zero so the caller can decide.
      if (error instanceof PostWriteError) {
        process.stderr.write(
          `trekoon: daemon may have committed; do not retry: ${error.message}\n`,
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  const result = await executeShell(parsed);
  const rendered: string = renderShellResult(result, parsed.mode, parsed.compatibilityMode, { compact: parsed.compact });

  if (result.ok) {
    process.stdout.write(`${rendered}\n`);
    return;
  }

  process.stderr.write(`${rendered}\n`);
  process.exitCode = 1;
}

if (import.meta.main) {
  await run();
}
