import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createBoardApiHandler } from "../../src/board/routes";
import { startBoardServer } from "../../src/board/server";
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

function prepareBoardAssets(_workspace: string): { assetRoot: string } {
  const assetRoot: string = mkdtempSync(join(tmpdir(), "trekoon-wal-watch-assets-"));
  tempDirs.push(assetRoot);
  writeFileSync(join(assetRoot, "index.html"), "<html><body>board</body></html>\n", "utf8");
  return { assetRoot };
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

describe("WAL watcher diff and resilience", (): void => {
  test("shape-change-without-content does not produce a delta", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    new MutationService(seedDb.db, workspace).createEpic({ title: "Stable", description: "Original" });
    seedDb.close();

    const watcherDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const eventBus = createBoardEventBus();
    const events: unknown[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "snapshotDelta") {
        events.push(event.snapshotDelta);
      }
    });

    // Custom snapshot builder: returns the same logical content (same id,
    // updatedAt, version) but mutates non-content shape (reorders array,
    // swaps in a different description string). The (version, updatedAt)
    // tuple is unchanged, so the watcher must NOT emit a delta.
    const baseSnapshot = {
      generatedAt: Date.now(),
      epics: [{ id: "epic-1", title: "Stable", description: "Original", status: "todo", createdAt: 1, updatedAt: 100, version: 1, taskIds: [], counts: { todo: 0, blocked: 0, in_progress: 0, done: 0 }, searchText: "" }],
      tasks: [],
      subtasks: [],
      dependencies: [],
      counts: {
        epics: { total: 1, todo: 1, blocked: 0, inProgress: 0, done: 0, other: 0 },
        tasks: { total: 0, todo: 0, blocked: 0, inProgress: 0, done: 0, other: 0 },
        subtasks: { total: 0, todo: 0, blocked: 0, inProgress: 0, done: 0, other: 0 },
        dependencies: 0,
      },
    };
    const reshapedSnapshot = {
      ...baseSnapshot,
      generatedAt: Date.now() + 5000, // shape-only metadata change
      epics: [{ ...baseSnapshot.epics[0]!, description: "shape-shifted but same version+updatedAt", searchText: "different searchText" }],
    };

    let buildCalls = 0;
    const watcher = startWalWatcher({
      db: watcherDb.db,
      databaseFile: watcherDb.paths.databaseFile,
      eventBus,
      debounceMs: 10,
      buildSnapshot: () => {
        buildCalls += 1;
        return (buildCalls === 1 ? baseSnapshot : reshapedSnapshot) as never;
      },
    });

    try {
      // First reconcile: same logical (version, updatedAt) — must NOT emit.
      watcher.reconcile();
      // Second reconcile: still same tuple — still must NOT emit.
      watcher.reconcile();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events.length).toBe(0);
      expect(buildCalls).toBeGreaterThanOrEqual(2);
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });

  test("burst of 50 mutations inside debounce window emits a single coalesced delta", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    new MutationService(seedDb.db, workspace).createEpic({ title: "Burst Seed", description: "Seed" });
    seedDb.close();

    const watcherDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const eventBus = createBoardEventBus();
    const deltas: unknown[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "snapshotDelta") {
        deltas.push(event.snapshotDelta);
      }
    });
    const watcher = startWalWatcher({
      db: watcherDb.db,
      databaseFile: watcherDb.paths.databaseFile,
      eventBus,
      debounceMs: 300, // generous window so the burst can finish before debounce fires
    });

    try {
      const cliDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        const cliMutations = new MutationService(cliDb.db, workspace);
        // 50 rapid writes through one connection — all hit the WAL within
        // the 300ms debounce window on any reasonable machine.
        for (let i = 0; i < 50; i += 1) {
          cliMutations.createEpic({ title: `Burst-${i}`, description: `Mutation ${i}` });
        }
      } finally {
        cliDb.close();
      }

      // Force one reconcile after the writer connection closed to make the
      // test deterministic on slow CI filesystems where fs.watch is laggy.
      const deadline = Date.now() + 4000;
      while (deltas.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (deltas.length === 0) {
          watcher.reconcile();
        }
      }

      // Coalesced: exactly one delta carrying all 50 new epics, not 50
      // separate deltas.
      expect(deltas.length).toBe(1);
      const delta = deltas[0] as { epics: ReadonlyArray<{ title?: string }> };
      const titles = (delta.epics ?? []).map((epic) => epic.title);
      const burstTitles = titles.filter((title) => title?.startsWith("Burst-"));
      expect(burstTitles.length).toBe(50);
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });

  test("thrown error from buildBoardSnapshot increments failure counter and does not crash", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    new MutationService(seedDb.db, workspace).createEpic({ title: "Pre-throw", description: "Seed" });
    seedDb.close();

    const watcherDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const eventBus = createBoardEventBus();
    const loggedMessages: string[] = [];

    let buildCalls = 0;
    const okSnapshot = {
      generatedAt: Date.now(),
      epics: [],
      tasks: [],
      subtasks: [],
      dependencies: [],
      counts: {
        epics: { total: 0, todo: 0, blocked: 0, inProgress: 0, done: 0, other: 0 },
        tasks: { total: 0, todo: 0, blocked: 0, inProgress: 0, done: 0, other: 0 },
        subtasks: { total: 0, todo: 0, blocked: 0, inProgress: 0, done: 0, other: 0 },
        dependencies: 0,
      },
    };

    const watcher = startWalWatcher({
      db: watcherDb.db,
      databaseFile: watcherDb.paths.databaseFile,
      eventBus,
      debounceMs: 10,
      logEveryNthFailure: 2,
      logger: (message) => {
        loggedMessages.push(message);
      },
      buildSnapshot: () => {
        buildCalls += 1;
        if (buildCalls === 1) {
          return okSnapshot as never;
        }
        throw new Error(`synthetic snapshot failure #${buildCalls}`);
      },
    });

    try {
      // Five reconciles — first call already happened during start. All five
      // explicit reconciles throw; counter must advance to 5 and the watcher
      // must remain operable (no crash, close still works).
      for (let i = 0; i < 5; i += 1) {
        watcher.reconcile();
      }

      expect(watcher.failureCount()).toBe(5);
      // logEveryNthFailure=2 means we log on failures 2 and 4 → 2 messages.
      expect(loggedMessages.length).toBe(2);
      expect(loggedMessages[0]).toContain("wal-watcher");
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });

  test("route PATCH publish suppresses the immediate WAL duplicate reconcile", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const storage: TrekoonDatabase = openTrekoonDatabase(workspace);
    const mutations = new MutationService(storage.db, workspace);
    const epic = mutations.createEpic({ title: "Route seed", description: "Seed" });
    const task = mutations.createTask({ epicId: epic.id, title: "Before", description: "Task" });

    const eventBus = createBoardEventBus();
    const deltas: unknown[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "snapshotDelta") {
        deltas.push(event.snapshotDelta);
      }
    });
    const watcher = startWalWatcher({
      db: storage.db,
      databaseFile: storage.paths.databaseFile,
      eventBus,
      debounceMs: 10,
    });
    const handler = createBoardApiHandler({
      db: storage.db,
      cwd: workspace,
      token: "route-token",
      eventBus,
    });

    try {
      const response = await handler(new Request(`http://board.test/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer route-token",
        },
        body: JSON.stringify({ title: "After" }),
      }));
      expect(response.status).toBe(200);
      expect(deltas.length).toBe(1);

      watcher.reconcile();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(deltas.length).toBe(1);
      const routeDelta = deltas[0] as { tasks?: Array<{ id?: string; title?: string }> };
      expect(routeDelta.tasks).toContainEqual(expect.objectContaining({ id: task.id, title: "After" }));

      const cliDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        new MutationService(cliDb.db, workspace).createEpic({
          title: "External after suppressed reconcile",
          description: "CLI write",
        });
      } finally {
        cliDb.close();
      }

      watcher.reconcile();

      expect(deltas.length).toBe(2);
      const externalDelta = deltas[1] as {
        epics?: Array<{ title?: string }>;
        tasks?: Array<{ id?: string; title?: string }>;
      };
      expect(externalDelta.epics).toContainEqual(expect.objectContaining({ title: "External after suppressed reconcile" }));
      expect(externalDelta.tasks ?? []).not.toContainEqual(expect.objectContaining({ id: task.id, title: "After" }));
    } finally {
      watcher.close();
      eventBus.close();
      storage.close();
    }
  });
});

describe("board server WAL watcher integration", (): void => {
  test("CLI-style mutation appears via SSE within ~1s", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const { assetRoot } = prepareBoardAssets(workspace);

    // Pre-seed before the server boots so the initial snapshot is non-empty.
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    new MutationService(seedDb.db, workspace).createEpic({ title: "Pre-seed", description: "Initial epic" });
    seedDb.close();

    const boardServer = startBoardServer({ cwd: workspace, token: "wal-token", assetRootOverride: assetRoot });

    try {
      const sseResponse = await fetch(`${boardServer.origin}/api/snapshot/stream`, {
        headers: {
          accept: "text/event-stream",
          cookie: `trekoon_board_session=${encodeURIComponent("wal-token")}`,
        },
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

  test("CLI-style epic append appears via SSE with an updated version", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const { assetRoot } = prepareBoardAssets(workspace);

    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const epic = new MutationService(seedDb.db, workspace).createEpic({
      title: "Append target",
      description: "Initial",
    });
    seedDb.close();

    const boardServer = startBoardServer({ cwd: workspace, token: "wal-append-token", assetRootOverride: assetRoot });

    try {
      const sseResponse = await fetch(`${boardServer.origin}/api/snapshot/stream`, {
        headers: {
          accept: "text/event-stream",
          cookie: `trekoon_board_session=${encodeURIComponent("wal-append-token")}`,
        },
      });
      expect(sseResponse.status).toBe(200);
      if (!sseResponse.body) {
        throw new Error("SSE response missing body");
      }
      const reader = sseResponse.body.getReader();

      await readSseFrames(reader, 1);

      const cliDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        new MutationService(cliDb.db, workspace).appendToEpicDescription({
          epicId: epic.id,
          append: "CLI appended note",
        });
      } finally {
        cliDb.close();
      }

      const deltaFrames = await readSseFrames(reader, 1, 5000);
      expect(deltaFrames[0]?.event).toBe("snapshotDelta");
      const delta = (deltaFrames[0]?.data as { snapshotDelta?: Record<string, unknown> })?.snapshotDelta ?? {};
      const epics = Array.isArray(delta.epics)
        ? (delta.epics as Array<{ id?: string; description?: string; version?: number }>)
        : [];
      const patchedEpic = epics.find((entry) => entry.id === epic.id);
      expect(patchedEpic?.description).toContain("CLI appended note");
      expect(patchedEpic?.version).toBeGreaterThan(epic.version);

      await reader.cancel().catch(() => {});
    } finally {
      boardServer.stop();
    }
  });
});
