#!/usr/bin/env bun

/**
 * Spike bench: cold one-shot CLI vs daemon-routed `session` calls.
 *
 * Usage:
 *   bun bench/daemon-session.ts
 *
 * The script:
 *   1. Spins up a temp git workspace, runs `trekoon init`, prepares state.
 *   2. Times N cold `bun src/index.ts session` invocations (full process start).
 *   3. Starts the daemon, times N socket round-trips for the same command.
 *   4. Prints per-iteration timings + median for each path.
 *
 * Acceptance signal (spike): daemon median < 10ms, cold median > 50ms.
 */

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { sendDaemonRequest } from "../src/runtime/daemon";

const ITERATIONS = 5;
const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(REPO_ROOT, "src", "index.ts");

interface BenchSample {
  readonly iteration: number;
  readonly ms: number;
}

interface BenchSummary {
  readonly label: string;
  readonly samples: readonly BenchSample[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b): number => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1]! + sorted[middle]!) / 2;
  }
  return sorted[middle]!;
}

function setupWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-bench-"));
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, ".gitignore"), ".trekoon/\n", "utf8");
  writeFileSync(join(workspace, "README.md"), "# Bench\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Trekoon Bench",
      "-c",
      "user.email=bench@trekoon.local",
      "commit",
      "-m",
      "init",
    ],
    { cwd: workspace, stdio: "ignore" },
  );

  // Bootstrap tracker once so subsequent session calls land on real state.
  execFileSync("bun", [ENTRY, "--toon", "init"], { cwd: workspace, stdio: "ignore" });
  return workspace;
}

function benchCold(workspace: string, iterations: number): BenchSummary {
  const samples: BenchSample[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    execFileSync("bun", [ENTRY, "--toon", "session"], {
      cwd: workspace,
      stdio: "ignore",
    });
    const elapsed = performance.now() - start;
    samples.push({ iteration: index + 1, ms: elapsed });
  }
  return { label: "cold (one-shot CLI)", samples };
}

async function benchDaemon(
  socketPath: string,
  workspace: string,
  iterations: number,
): Promise<BenchSummary> {
  const samples: BenchSample[] = [];
  // Warmup: first call pays the lazy-load cost on the daemon side.
  await sendDaemonRequest(socketPath, {
    argv: ["--toon", "session"],
    cwd: workspace,
  });
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    await sendDaemonRequest(socketPath, {
      argv: ["--toon", "session"],
      cwd: workspace,
    });
    const elapsed = performance.now() - start;
    samples.push({ iteration: index + 1, ms: elapsed });
  }
  return { label: "daemon (Unix socket)", samples };
}

function reportSummary(summary: BenchSummary): void {
  const values = summary.samples.map((sample): number => sample.ms);
  const med = median(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  process.stdout.write(`\n${summary.label}\n`);
  for (const sample of summary.samples) {
    process.stdout.write(`  iter ${sample.iteration}: ${sample.ms.toFixed(2)} ms\n`);
  }
  process.stdout.write(
    `  median=${med.toFixed(2)}ms  min=${min.toFixed(2)}ms  max=${max.toFixed(2)}ms\n`,
  );
}

function startDaemonProcess(workspace: string): Promise<{
  process: ChildProcessWithoutNullStreams;
  socketPath: string;
}> {
  return new Promise((resolveStart, rejectStart): void => {
    const child = spawn("bun", [ENTRY, "serve"], {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const cleanup = (): void => {
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string): void => {
      const match = data.match(/listening on (.+\.sock)/);
      if (match) {
        cleanup();
        resolveStart({ process: child, socketPath: match[1]!.trim() });
      }
    });
    child.stderr.on("data", (data: string): void => {
      process.stderr.write(`[daemon stderr] ${data}`);
    });
    child.on("exit", (code: number | null): void => {
      cleanup();
      rejectStart(new Error(`daemon exited before listening (code=${code})`));
    });
  });
}

async function main(): Promise<void> {
  const workspace = setupWorkspace();
  process.stdout.write(`workspace: ${workspace}\n`);
  process.stdout.write(`iterations per path: ${ITERATIONS}\n`);

  let coldSummary: BenchSummary | null = null;
  let daemonSummary: BenchSummary | null = null;
  let daemon: { process: ChildProcessWithoutNullStreams; socketPath: string } | null = null;

  try {
    coldSummary = benchCold(workspace, ITERATIONS);
    reportSummary(coldSummary);

    daemon = await startDaemonProcess(workspace);
    process.stdout.write(`\ndaemon socket: ${daemon.socketPath}\n`);

    daemonSummary = await benchDaemon(daemon.socketPath, workspace, ITERATIONS);
    reportSummary(daemonSummary);

    const coldMedian = median(coldSummary.samples.map((sample): number => sample.ms));
    const daemonMedian = median(daemonSummary.samples.map((sample): number => sample.ms));
    const speedup = coldMedian / daemonMedian;
    process.stdout.write(
      `\nspeedup: cold/daemon = ${speedup.toFixed(1)}x (cold=${coldMedian.toFixed(1)}ms, daemon=${daemonMedian.toFixed(1)}ms)\n`,
    );

    if (daemonMedian >= 10) {
      process.stderr.write(`WARN: daemon median ${daemonMedian.toFixed(2)}ms >= 10ms target\n`);
    }
    if (coldMedian <= 50) {
      process.stderr.write(`WARN: cold median ${coldMedian.toFixed(2)}ms <= 50ms — env may be unrealistic\n`);
    }
  } finally {
    if (daemon) {
      daemon.process.kill("SIGINT");
      // Best-effort wait for clean exit.
      await new Promise<void>((settle): void => {
        const timer = setTimeout((): void => settle(), 500);
        daemon!.process.once("exit", (): void => {
          clearTimeout(timer);
          settle();
        });
      });
    }
    rmSync(workspace, { recursive: true, force: true });
  }
}

await main();
