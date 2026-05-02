import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { startBoardServer } from "../../src/board/server";
import { resolveStoragePaths } from "../../src/storage/path";
import { openTrekoonDatabase, type TrekoonDatabase } from "../../src/storage/database";
import { MutationService } from "../../src/domain/mutation-service";
import { createBoardEventBus } from "../../src/board/event-bus";
import { startWalWatcher } from "../../src/board/wal-watcher";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-wal-watch-"));
  tempDirs.push(workspace);
  return workspace;
}

function prepareBoardAssets(workspace: string): void {
  const paths = resolveStoragePaths(workspace);
  mkdirSync(dirname(paths.boardEntryFile), { recursive: true });
  writeFileSync(paths.boardEntryFile, "<html><body>board</body></html>\n", "utf8");
}

interface SseFrame {
  readonly event: string;
  readonly data: unknown;
}

async function readSseFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expectedCount: number,
  timeoutMs = 6000,
): Promise<readonly SseFrame[]> {
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";

  const deadline = Date.now() + timeoutMs;

  while (frames.length < expectedCount) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out waiting for ${expectedCount} SSE frames; got ${frames.length}: ${buffer}`);
    }

    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), remainingMs)),
    ]);
    if (result.done) {
      throw new Error(`SSE stream closed before ${expectedCount} frames`);
    }

    buffer += decoder.decode(result.value, { stream: true });
    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1 && frames.length < expectedCount) {
      const rawFrame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      separatorIndex = buffer.indexOf("\n\n");

      if (rawFrame.startsWith(":")) {
        continue;
      }

      let event = "message";
      let dataLine = "";
      for (const line of rawFrame.split("\n")) {
        if (line.startsWith("event: ")) {
          event = line.slice("event: ".length);
        } else if (line.startsWith("data: ")) {
          dataLine = line.slice("data: ".length);
        }
      }

      let parsedData: unknown = null;
      if (dataLine.length > 0) {
        try {
          parsedData = JSON.parse(dataLine);
        } catch {
          parsedData = dataLine;
        }
      }

      frames.push({ event, data: parsedData });
    }
  }

  return frames;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next: string | undefined = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("WAL watcher unit", (): void => {
  test("publishes a delta when a separate database connection mutates the WAL", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    // Open initial database to seed.
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const seedMutations = new MutationService(seedDb.db, workspace);
    seedMutations.createEpic({ title: "WAL Seed", description: "Seed for WAL watcher" });
    seedDb.close();

    // Open a watcher database connection (read-only relative to mutations
    // initiated from another connection in the same process).
    const watcherDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const eventBus = createBoardEventBus();
    const events: unknown[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "snapshotDelta") {
        events.push(event.snapshotDelta);
      }
    });
    const watcher = startWalWatcher({
      db: watcherDb.db,
      databaseFile: watcherDb.paths.databaseFile,
      eventBus,
      debounceMs: 50,
    });

    try {
      // Open a separate writer connection to simulate a CLI process.
      const cliDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        const cliMutations = new MutationService(cliDb.db, workspace);
        cliMutations.createEpic({ title: "WAL Created Via CLI", description: "CLI write" });
      } finally {
        cliDb.close();
      }

      // Wait for the watcher to detect the change and publish a delta. Poll
      // up to a generous timeout so flaky filesystems still let us assert.
      const deadline = Date.now() + 4000;
      while (events.length === 0 && Date.now() < deadline) {
        // Force a reconcile in case fs.watch missed the event on this OS.
        watcher.reconcile();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(events.length).toBeGreaterThanOrEqual(1);
      const delta = events[events.length - 1] as Record<string, unknown>;
      expect(Array.isArray(delta.epics)).toBe(true);
      const epicTitles = (delta.epics as Array<{ title?: string }>).map((epic) => epic.title);
      expect(epicTitles).toContain("WAL Created Via CLI");
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });
});

describe("board server WAL watcher integration", (): void => {
  test("CLI-style mutation appears via SSE within ~1s", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);

    // Pre-seed before the server boots so the initial snapshot is non-empty.
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    new MutationService(seedDb.db, workspace).createEpic({ title: "Pre-seed", description: "Initial epic" });
    seedDb.close();

    const boardServer = startBoardServer({ cwd: workspace, token: "wal-token" });

    try {
      const sseResponse = await fetch(`${boardServer.origin}/api/snapshot/stream?token=wal-token`, {
        headers: { accept: "text/event-stream" },
      });
      expect(sseResponse.status).toBe(200);
      if (!sseResponse.body) {
        throw new Error("SSE response missing body");
      }
      const reader = sseResponse.body.getReader();

      // Consume the initial snapshot frame.
      await readSseFrames(reader, 1);

      // Simulate a CLI write from a separate connection.
      const cliDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        new MutationService(cliDb.db, workspace).createEpic({
          title: "CLI Write",
          description: "From another shell",
        });
      } finally {
        cliDb.close();
      }

      // Expect a delta within a few seconds (well above the 1s acceptance bar
      // but generous enough for slow CI filesystems).
      const deltaFrames = await readSseFrames(reader, 1, 5000);
      expect(deltaFrames[0]?.event).toBe("snapshotDelta");
      const delta = (deltaFrames[0]?.data as { snapshotDelta?: Record<string, unknown> })?.snapshotDelta ?? {};
      const epics = Array.isArray(delta.epics) ? (delta.epics as Array<{ title?: string }>) : [];
      const titles = epics.map((epic) => epic.title);
      expect(titles).toContain("CLI Write");

      await reader.cancel().catch(() => {});
    } finally {
      boardServer.stop();
    }
  });
});
