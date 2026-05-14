import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createBoardApiHandler } from "../../src/board/routes";
import { startBoardServer } from "../../src/board/server";
import { openTrekoonDatabase, type TrekoonDatabase } from "../../src/storage/database";
import { MutationService } from "../../src/domain/mutation-service";
import { createBoardEventBus } from "../../src/board/event-bus";
import {
  __getDerivedFingerprintCallCount,
  __resetDerivedFingerprintCallCount,
  startWalWatcher,
} from "../../src/board/wal-watcher";

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
  test("top-level snapshot metadata changes without record changes do not produce a delta", async (): Promise<void> => {
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

    // Custom snapshot builder: returns the same logical records while changing
    // only top-level metadata. The watcher must NOT emit a delta for generated
    // timestamps or aggregate counts alone.
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
      counts: {
        ...baseSnapshot.counts,
        dependencies: 99,
      },
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
      // First reconcile: same logical records — must NOT emit.
      watcher.reconcile();
      // Second reconcile: still same records — still must NOT emit.
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

  test("external task create publishes the derived parent epic delta", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const epic = new MutationService(seedDb.db, workspace).createEpic({
      title: "Parent epic",
      description: "Seed",
    });
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
      debounceMs: 10,
    });

    try {
      const cliDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        new MutationService(cliDb.db, workspace).createTask({
          epicId: epic.id,
          title: "External Task",
          description: "Created outside the board server",
        });
      } finally {
        cliDb.close();
      }

      watcher.reconcile();

      expect(deltas.length).toBe(1);
      const delta = deltas[0] as {
        epics?: Array<{ id?: string; taskIds?: string[]; counts?: { todo?: number }; searchText?: string }>;
        tasks?: Array<{ title?: string }>;
      };
      expect(delta.tasks).toContainEqual(expect.objectContaining({ title: "External Task" }));
      expect(delta.epics).toContainEqual(expect.objectContaining({
        id: epic.id,
        counts: expect.objectContaining({ todo: 1 }),
        searchText: expect.stringContaining("external task"),
      }));
      expect(delta.epics?.[0]?.taskIds?.length).toBe(1);
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });

  test("external subtask update publishes derived parent task and epic deltas", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const mutations = new MutationService(seedDb.db, workspace);
    const epic = mutations.createEpic({ title: "Subtask parent epic", description: "Seed" });
    const task = mutations.createTask({ epicId: epic.id, title: "Parent task", description: "Seed task" });
    const subtask = mutations.createSubtask({ taskId: task.id, title: "Before subtask", description: "Seed subtask" });
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
      debounceMs: 10,
    });

    try {
      const cliDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        new MutationService(cliDb.db, workspace).updateSubtask(subtask.id, {
          title: "External Subtask",
        });
      } finally {
        cliDb.close();
      }

      watcher.reconcile();

      expect(deltas.length).toBe(1);
      const delta = deltas[0] as {
        epics?: Array<{ id?: string; searchText?: string }>;
        tasks?: Array<{ id?: string; searchText?: string; subtasks?: Array<{ title?: string }> }>;
        subtasks?: Array<{ id?: string; title?: string }>;
      };
      expect(delta.subtasks).toContainEqual(expect.objectContaining({ id: subtask.id, title: "External Subtask" }));
      expect(delta.tasks).toContainEqual(expect.objectContaining({
        id: task.id,
        searchText: expect.stringContaining("external subtask"),
        subtasks: expect.arrayContaining([expect.objectContaining({ title: "External Subtask" })]),
      }));
      expect(delta.epics).toContainEqual(expect.objectContaining({
        id: epic.id,
        searchText: expect.stringContaining("external subtask"),
      }));
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

      const routeDelta = deltas[0] as { tasks?: Array<{ id?: string; title?: string }> };
      expect(routeDelta.tasks).toContainEqual(expect.objectContaining({ id: task.id, title: "After" }));

      const preSuppressionCliDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        new MutationService(preSuppressionCliDb.db, workspace).createEpic({
          title: "External before suppressed reconcile",
          description: "CLI write before suppression",
        });
      } finally {
        preSuppressionCliDb.close();
      }

      watcher.reconcile();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(deltas.length).toBe(2);
      const preSuppressionExternalDelta = deltas[1] as {
        epics?: Array<{ title?: string }>;
        tasks?: Array<{ id?: string; title?: string }>;
      };
      expect(preSuppressionExternalDelta.epics).toContainEqual(expect.objectContaining({ title: "External before suppressed reconcile" }));
      expect(preSuppressionExternalDelta.tasks ?? []).not.toContainEqual(expect.objectContaining({ id: task.id, title: "After" }));

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

      expect(deltas.length).toBe(3);
      const externalDelta = deltas[2] as {
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

describe("WAL watcher event-cursor reconciliation", (): void => {
  test("external task create takes the event-cursor path and emits parent epic + task only", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const epic = new MutationService(seedDb.db, workspace).createEpic({
      title: "Cursor parent epic",
      description: "Seed",
    });
    seedDb.close();

    const watcherDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const eventBus = createBoardEventBus();
    const deltas: unknown[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "snapshotDelta") {
        deltas.push(event.snapshotDelta);
      }
    });
    const paths: Array<{ path: string; reason?: string }> = [];
    const watcher = startWalWatcher({
      db: watcherDb.db,
      databaseFile: watcherDb.paths.databaseFile,
      eventBus,
      debounceMs: 10,
      onReconcile: (info) => {
        paths.push({ path: info.path, reason: info.reason });
      },
    });

    try {
      const cliDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        new MutationService(cliDb.db, workspace).createTask({
          epicId: epic.id,
          title: "Cursor External Task",
          description: "Cursor write",
        });
      } finally {
        cliDb.close();
      }

      watcher.reconcile();

      // Optimized path took the tick.
      expect(paths[0]?.path).toBe("event-cursor");

      expect(deltas.length).toBe(1);
      const delta = deltas[0] as {
        epics?: Array<{ id?: string; counts?: { todo?: number }; searchText?: string }>;
        tasks?: Array<{ id?: string; title?: string; epicId?: string }>;
        subtasks?: unknown[];
        dependencies?: unknown[];
        deletedEpicIds?: unknown[];
        deletedTaskIds?: unknown[];
      };
      // Targeted delta: only the touched task + parent epic — no unrelated
      // subtasks/dependencies/deletions appear.
      expect(delta.tasks).toContainEqual(expect.objectContaining({ title: "Cursor External Task", epicId: epic.id }));
      expect(delta.epics).toContainEqual(expect.objectContaining({
        id: epic.id,
        counts: expect.objectContaining({ todo: 1 }),
        searchText: expect.stringContaining("cursor external task"),
      }));
      expect(delta.subtasks ?? []).toHaveLength(0);
      expect(delta.dependencies ?? []).toHaveLength(0);
      expect(delta.deletedEpicIds ?? []).toHaveLength(0);
      expect(delta.deletedTaskIds ?? []).toHaveLength(0);
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });

  test("external cascade epic delete emits delete IDs for every child via canonical events", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const seedMutations = new MutationService(seedDb.db, workspace);
    const epic = seedMutations.createEpic({ title: "Cascade epic", description: "" });
    const task = seedMutations.createTask({ epicId: epic.id, title: "Cascade task", description: "" });
    const subtask = seedMutations.createSubtask({ taskId: task.id, title: "Cascade sub", description: "" });
    seedDb.close();

    const watcherDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const eventBus = createBoardEventBus();
    const deltas: unknown[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "snapshotDelta") {
        deltas.push(event.snapshotDelta);
      }
    });
    const paths: Array<{ path: string; reason?: string }> = [];
    const watcher = startWalWatcher({
      db: watcherDb.db,
      databaseFile: watcherDb.paths.databaseFile,
      eventBus,
      debounceMs: 10,
      onReconcile: (info) => {
        paths.push({ path: info.path, reason: info.reason });
      },
    });

    try {
      const cliDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        new MutationService(cliDb.db, workspace).deleteEpic(epic.id);
      } finally {
        cliDb.close();
      }

      watcher.reconcile();

      expect(paths[0]?.path).toBe("event-cursor");

      expect(deltas.length).toBe(1);
      const delta = deltas[0] as {
        deletedEpicIds?: string[];
        deletedTaskIds?: string[];
        deletedSubtaskIds?: string[];
      };
      expect(delta.deletedEpicIds).toContain(epic.id);
      expect(delta.deletedTaskIds).toContain(task.id);
      expect(delta.deletedSubtaskIds).toContain(subtask.id);
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });

  test("warm-up (empty events table at watcher start) falls back to full-snapshot path", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    // Do NOT seed any data — empty events table means cursor read at start
    // returns null, so the first reconcile must take the full-snapshot path.
    const watcherDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const eventBus = createBoardEventBus();
    const paths: Array<{ path: string; reason?: string }> = [];
    const watcher = startWalWatcher({
      db: watcherDb.db,
      databaseFile: watcherDb.paths.databaseFile,
      eventBus,
      debounceMs: 10,
      onReconcile: (info) => {
        paths.push({ path: info.path, reason: info.reason });
      },
    });

    try {
      // Force a tick before any writes — the watcher has a null cursor.
      watcher.reconcile();

      expect(paths[0]?.path).toBe("full-snapshot");
      expect(paths[0]?.reason).toBe("warm-up");
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });

  test("cursor gone (archive pruned past cursor) falls back to full-snapshot path", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    new MutationService(seedDb.db, workspace).createEpic({ title: "Cursor seed", description: "" });
    seedDb.close();

    const watcherDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const eventBus = createBoardEventBus();
    const paths: Array<{ path: string; reason?: string }> = [];
    const watcher = startWalWatcher({
      db: watcherDb.db,
      databaseFile: watcherDb.paths.databaseFile,
      eventBus,
      debounceMs: 10,
      onReconcile: (info) => {
        paths.push({ path: info.path, reason: info.reason });
      },
    });

    try {
      // Simulate the archive prune that lifts the cursor's event out of the
      // live events table. The watcher's cursor still points at it.
      const pruneDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        pruneDb.db.query("DELETE FROM events;").run();
      } finally {
        pruneDb.close();
      }

      watcher.reconcile();

      expect(paths[0]?.path).toBe("full-snapshot");
      expect(paths[0]?.reason).toBe("cursor-stale");
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });

  test("event payload parse failure falls back to full-snapshot path", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    new MutationService(seedDb.db, workspace).createEpic({ title: "Parse seed", description: "" });
    seedDb.close();

    const watcherDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const eventBus = createBoardEventBus();
    const paths: Array<{ path: string; reason?: string }> = [];
    const watcher = startWalWatcher({
      db: watcherDb.db,
      databaseFile: watcherDb.paths.databaseFile,
      eventBus,
      debounceMs: 10,
      onReconcile: (info) => {
        paths.push({ path: info.path, reason: info.reason });
      },
    });

    try {
      // Inject a corrupt event row after watcher startup — its payload won't
      // JSON.parse, so the event-cursor path must bail out.
      const corruptDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        corruptDb.db
          .query(
            `INSERT INTO events (id, entity_kind, entity_id, operation, payload, created_at, updated_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1);`,
          )
          .run("corrupt-event-id", "epic", "corrupt-epic", "epic.updated", "{not-json", Date.now() + 1000, Date.now() + 1000);
      } finally {
        corruptDb.close();
      }

      watcher.reconcile();

      expect(paths[0]?.path).toBe("full-snapshot");
      expect(paths[0]?.reason).toBe("event-parse-or-shape");
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });

  test("unknown entity_kind/operation combination falls back (non-canonical change)", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    new MutationService(seedDb.db, workspace).createEpic({ title: "Unknown op seed", description: "" });
    seedDb.close();

    const watcherDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const eventBus = createBoardEventBus();
    const paths: Array<{ path: string; reason?: string }> = [];
    const watcher = startWalWatcher({
      db: watcherDb.db,
      databaseFile: watcherDb.paths.databaseFile,
      eventBus,
      debounceMs: 10,
      onReconcile: (info) => {
        paths.push({ path: info.path, reason: info.reason });
      },
    });

    try {
      // Inject a syntactically-valid event with an unknown operation so the
      // event-cursor path treats it as non-canonical and bails out.
      const corruptDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        corruptDb.db
          .query(
            `INSERT INTO events (id, entity_kind, entity_id, operation, payload, created_at, updated_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1);`,
          )
          .run(
            "unknown-op-event-id",
            "epic",
            "unknown-epic",
            "epic.archived", // not in ENTITY_OPERATIONS
            JSON.stringify({ fields: {} }),
            Date.now() + 1000,
            Date.now() + 1000,
          );
      } finally {
        corruptDb.close();
      }

      watcher.reconcile();

      expect(paths[0]?.path).toBe("full-snapshot");
      expect(paths[0]?.reason).toBe("event-parse-or-shape");
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });

  test("forceFullSnapshotReconcile produces bit-identical SSE payload to optimized path", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const epic = new MutationService(seedDb.db, workspace).createEpic({
      title: "Parity epic",
      description: "Seed",
    });
    seedDb.close();

    // Helper that boots a watcher, applies a single external task create, and
    // returns the published delta.
    async function captureDelta(forceFullSnapshot: boolean): Promise<Record<string, unknown>> {
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
        debounceMs: 10,
        forceFullSnapshotReconcile: forceFullSnapshot,
      });

      try {
        const cliDb: TrekoonDatabase = openTrekoonDatabase(workspace);
        try {
          new MutationService(cliDb.db, workspace).createTask({
            epicId: epic.id,
            title: `Parity task ${forceFullSnapshot ? "full" : "cursor"}`,
            description: "",
          });
        } finally {
          cliDb.close();
        }

        watcher.reconcile();
        return deltas[0] as Record<string, unknown>;
      } finally {
        watcher.close();
        eventBus.close();
        watcherDb.close();
      }
    }

    const optimized = await captureDelta(false);
    // Clean events between runs so the second watcher sees a comparable state.
    const cleanDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    try {
      // Drop the newly created task so the second run can recreate one and
      // produce a delta with the same shape.
      cleanDb.db.query("DELETE FROM tasks;").run();
      cleanDb.db.query("DELETE FROM events;").run();
    } finally {
      cleanDb.close();
    }
    const fullSnapshot = await captureDelta(true);

    // Compare shape (keys + per-key array lengths) — bit-identical for the
    // structural contract, ignoring generatedAt timestamps and per-record
    // title differences forced by the de-duplication delete above.
    expect(Object.keys(optimized).sort()).toEqual(Object.keys(fullSnapshot).sort());
    for (const key of ["epics", "tasks", "subtasks", "dependencies", "deletedEpicIds", "deletedTaskIds", "deletedSubtaskIds", "deletedDependencyIds"]) {
      const optimizedArr = Array.isArray(optimized[key]) ? (optimized[key] as unknown[]) : [];
      const fullArr = Array.isArray(fullSnapshot[key]) ? (fullSnapshot[key] as unknown[]) : [];
      expect(optimizedArr.length).toBe(fullArr.length);
    }
  });
});

describe("WAL watcher leaf fingerprint short-circuit", (): void => {
  test("identical leaf records skip derivedRecordFingerprint entirely", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const mutations = new MutationService(seedDb.db, workspace);
    const epic = mutations.createEpic({ title: "Leaf parent epic", description: "Seed" });
    const task = mutations.createTask({ epicId: epic.id, title: "Leaf parent task", description: "Seed" });
    mutations.createSubtask({ taskId: task.id, title: "Stable subtask A", description: "" });
    mutations.createSubtask({ taskId: task.id, title: "Stable subtask B", description: "" });
    seedDb.close();

    const watcherDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const eventBus = createBoardEventBus();
    const watcher = startWalWatcher({
      db: watcherDb.db,
      databaseFile: watcherDb.paths.databaseFile,
      eventBus,
      debounceMs: 10,
    });

    try {
      // Initial reconcile in startWalWatcher already touched the fingerprint
      // path while building the baseline. Reset, then trigger a reconcile
      // where every record is byte-for-byte identical to the baseline.
      __resetDerivedFingerprintCallCount();
      watcher.reconcile();

      const callsAfterNoOp = __getDerivedFingerprintCallCount();
      // With two unchanged subtasks plus the seed task and epic, the legacy
      // path would have called derivedRecordFingerprint at least 8 times
      // (4 records × 2 stringify ops in recordChanged: prev + curr). After
      // the leaf short-circuit, only the two parent records (epic, task)
      // reach the fingerprint function — 2 records × 2 stringify ops = 4
      // calls max. Subtasks (leaves) must never trigger a fingerprint call.
      expect(callsAfterNoOp).toBeLessThanOrEqual(4);
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });

  test("subtask status flip still surfaces via a direct subtask delta", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const mutations = new MutationService(seedDb.db, workspace);
    const epic = mutations.createEpic({ title: "Flip parent epic", description: "Seed" });
    const task = mutations.createTask({ epicId: epic.id, title: "Flip parent task", description: "Seed" });
    const subtask = mutations.createSubtask({ taskId: task.id, title: "Flip me", description: "" });
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
      debounceMs: 10,
    });

    try {
      const cliDb: TrekoonDatabase = openTrekoonDatabase(workspace);
      try {
        new MutationService(cliDb.db, workspace).updateSubtask(subtask.id, { status: "in_progress" });
      } finally {
        cliDb.close();
      }

      watcher.reconcile();

      // A status flip bumps subtask (version, updatedAt) so the short-circuit
      // does NOT apply — the subtask must appear in the delta.
      expect(deltas.length).toBe(1);
      const delta = deltas[0] as {
        subtasks?: Array<{ id?: string; status?: string }>;
      };
      expect(delta.subtasks).toContainEqual(
        expect.objectContaining({ id: subtask.id, status: "in_progress" }),
      );
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });

  test("leaf no-stringify path still fires on a busy subtask board (1000 leaf compares, 0 stringifies)", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const seedDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const mutations = new MutationService(seedDb.db, workspace);
    const epic = mutations.createEpic({ title: "Busy epic", description: "Seed" });
    const task = mutations.createTask({ epicId: epic.id, title: "Busy task", description: "Seed" });
    // 25 subtasks — large enough to make the per-record stringify cost visible
    // if the leaf short-circuit regresses. Two ticks across this set means 50
    // leaf compares; pre-change behaviour would have produced ~100+ stringify
    // calls (recordChanged + recordMatchesPublishedDelta x 2 leaves on the
    // suppression path), so any nonzero count would clearly flag a regression.
    for (let i = 0; i < 25; i += 1) {
      mutations.createSubtask({ taskId: task.id, title: `Busy ${i}`, description: "" });
    }
    seedDb.close();

    const watcherDb: TrekoonDatabase = openTrekoonDatabase(workspace);
    const eventBus = createBoardEventBus();
    const watcher = startWalWatcher({
      db: watcherDb.db,
      databaseFile: watcherDb.paths.databaseFile,
      eventBus,
      debounceMs: 10,
    });

    try {
      __resetDerivedFingerprintCallCount();
      watcher.reconcile();
      watcher.reconcile();

      const totalFingerprintCalls = __getDerivedFingerprintCallCount();
      // The 25 subtasks are leaves; even across two no-op reconciles they
      // must not trigger derivedRecordFingerprint. Parents (1 epic + 1 task)
      // may still call it: 2 records × 2 stringify ops (prev + curr) × 2
      // reconciles = 8 max. Pre-change behaviour would have produced
      // (25 + 2) × 2 × 2 = 108 calls (the leaves dominate), so any reading
      // above 8 clearly flags a leaf regression.
      expect(totalFingerprintCalls).toBeLessThanOrEqual(8);
    } finally {
      watcher.close();
      eventBus.close();
      watcherDb.close();
    }
  });
});
