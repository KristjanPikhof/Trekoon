#!/usr/bin/env bun

import { executeShell, parseInvocation, renderShellResult } from "./runtime/cli-shell";

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseInvocation(argv);
  const result = await executeShell(parsed);
  const rendered: string = renderShellResult(result, parsed.mode);

  if (result.ok) {
    process.stdout.write(`${rendered}\n`);
    return;
  }

  process.stderr.write(`${rendered}\n`);
  process.exitCode = 1;
}

await run();
