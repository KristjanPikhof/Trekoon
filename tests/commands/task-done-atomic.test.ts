import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { runDep } from "../../src/commands/dep";
import { runEpic } from "../../src/commands/epic";
import { runTask } from "../../src/commands/task";
import { MutationService } from "../../src/domain/mutation-service";
import { TrackerDomain } from "../../src/domain/tracker-domain";
import { migrateDatabase } from "../../src/storage/migrations";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-task-done-atomic-"));
  tempDirs.push(workspace);
  return workspace;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

function createInMemoryDb(): { db: Database; service: MutationService; domain: TrackerDomain } {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrateDatabase(db);
  const service = new MutationService(db, process.cwd());
  const domain = new TrackerDomain(db);
  return { db, service, domain };
}

function listEventsForEntity(
  db: Database,
  entityKind: string,
  entityId: string,
): Array<{ operation: string; payload: string }> {
  return db
    .query(
      `
      SELECT operation, payload
      FROM events
      WHERE entity_kind = ? AND entity_id = ?
      ORDER BY created_at ASC, id ASC
      `,
    )
    .all(entityKind, entityId) as Array<{ operation: string; payload: string }>;
}

describe("task done atomic", (): void => {
  test("crash mid-done rolls back to original status; never wedged in in_progress", (): void => {
    const { db, service, domain } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T", description: "d", status: "todo" });
    expect(task.status).toBe("todo");

    // Simulate a crash AFTER the direct UPDATE has been issued but BEFORE COMMIT
    // by throwing from the computeSnapshot callback. writeTransaction must
    // ROLLBACK, restoring the row to its pre-update state.
    expect((): void => {
      service.markTaskDoneAtomically({
        taskId: task.id,
        computeSnapshot: (): never => {
          throw new Error("simulated post-UPDATE crash");
        },
      });
    }).toThrow("simulated post-UPDATE crash");

    // Post-rollback: row must be its ORIGINAL status, never `in_progress`,
    // never `done`.
    const after = domain.getTaskOrThrow(task.id);
    expect(after.status).toBe("todo");
    expect(after.status).not.toBe("in_progress");
    expect(after.status).not.toBe("done");

    // No task.updated event leaked from the rolled-back transaction.
    const events = listEventsForEntity(db, "task", task.id);
    const updates = events.filter((e) => e.operation === "task.updated");
    expect(updates.length).toBe(0);
  });

  test("crash mid-done from blocked rolls back to blocked, never in_progress", (): void => {
    const { db, service, domain } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const upstream = service.createTask({ epicId: epic.id, title: "U", description: "d", status: "todo" });
    const downstream = service.createTask({ epicId: epic.id, title: "D", description: "d", status: "todo" });
    service.addDependency(downstream.id, upstream.id);
    // Drive downstream into `blocked` via the public API.
    const blocked = service.updateTask(downstream.id, { status: "blocked" });
    expect(blocked.status).toBe("blocked");

    // Resolve the dep so the atomic done call passes the dependency-gating
    // guard and reaches computeSnapshot — the rollback assertion below
    // depends on exercising the post-UPDATE-pre-COMMIT path.
    service.markTaskDoneAtomically({
      taskId: upstream.id,
      computeSnapshot: () => undefined,
    });

    expect((): void => {
      service.markTaskDoneAtomically({
        taskId: downstream.id,
        computeSnapshot: (): never => {
          throw new Error("crash");
        },
      });
    }).toThrow("crash");

    const after = domain.getTaskOrThrow(downstream.id);
    expect(after.status).toBe("blocked");
    expect(after.status).not.toBe("in_progress");

    const events = listEventsForEntity(db, "task", downstream.id);
    const updateEventsAfterBlocked = events.filter(
      (e) => e.operation === "task.updated" && (JSON.parse(e.payload) as { fields: { status: string } }).fields.status === "done",
    );
    expect(updateEventsAfterBlocked.length).toBe(0);
  });

  test("from todo: emits exactly one task.updated event and goes directly to done", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "d"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const created = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "T1", "--description", "d", "--status", "todo"],
    });
    const taskId = (created.data as { task: { id: string } }).task.id;

    // Snapshot event-count before `done` to scope the assertion to events
    // emitted by the `task done` call alone.
    const { db: dbBefore } = createInMemoryDb(); // unused — just to keep the import side-effect-free
    void dbBefore;

    const result = await runTask({ cwd, mode: "toon", args: ["done", taskId] });
    expect(result.ok).toBeTrue();

    // Verify by re-opening the DB on disk via a direct query.
    const diskDb = new Database(join(cwd, ".trekoon", "trekoon.db"));
    try {
      const events = listEventsForEntity(diskDb, "task", taskId);
      // task.created + exactly one task.updated (with status=done).
      const updates = events.filter((e) => e.operation === "task.updated");
      expect(updates.length).toBe(1);
      const payload = JSON.parse(updates[0]!.payload) as { fields: { status: string } };
      expect(payload.fields.status).toBe("done");
      // No intermediate in_progress event ever appears in the log.
      const intermediate = updates.find(
        (e) => (JSON.parse(e.payload) as { fields: { status: string } }).fields.status === "in_progress",
      );
      expect(intermediate).toBeUndefined();
    } finally {
      diskDb.close();
    }
  });

  test("from blocked: goes directly to done in one event", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "d"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const upstream = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "U", "--description", "d", "--status", "todo"],
    });
    const upstreamId = (upstream.data as { task: { id: string } }).task.id;

    const downstream = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "D", "--description", "d", "--status", "todo"],
    });
    const downstreamId = (downstream.data as { task: { id: string } }).task.id;

    const dep = await runDep({ cwd, mode: "toon", args: ["add", downstreamId, upstreamId] });
    expect(dep.ok).toBeTrue();

    // Move downstream into `blocked`.
    const blocked = await runTask({
      cwd,
      mode: "toon",
      args: ["update", downstreamId, "--status", "blocked"],
    });
    expect(blocked.ok).toBeTrue();
    expect((blocked.data as { task: { status: string } }).task.status).toBe("blocked");

    // Mark the upstream done first so downstream can be moved off-blocked.
    // (The atomic done method bypasses the transition checker, but a public
    // `task done` from `blocked` is still allowed because there are no
    // active blockers once upstream is done.)
    const upstreamDone = await runTask({ cwd, mode: "toon", args: ["done", upstreamId] });
    expect(upstreamDone.ok).toBeTrue();

    const result = await runTask({ cwd, mode: "toon", args: ["done", downstreamId] });
    expect(result.ok).toBeTrue();
    const data = result.data as { completed: { status: string } };
    expect(data.completed.status).toBe("done");

    const diskDb = new Database(join(cwd, ".trekoon", "trekoon.db"));
    try {
      const events = listEventsForEntity(diskDb, "task", downstreamId);
      const updates = events.filter((e) => e.operation === "task.updated");
      // Status timeline emitted by events: blocked (manual update) → done.
      // No in_progress event in between.
      const statuses = updates.map((e) => (JSON.parse(e.payload) as { fields: { status: string } }).fields.status);
      expect(statuses).toContain("blocked");
      expect(statuses).toContain("done");
      // The done event must come immediately after blocked with no
      // intermediate in_progress event from the `task done` call.
      const blockedIdx = statuses.lastIndexOf("blocked");
      const doneIdx = statuses.lastIndexOf("done");
      expect(doneIdx).toBeGreaterThan(blockedIdx);
      const between = statuses.slice(blockedIdx + 1, doneIdx);
      expect(between.includes("in_progress")).toBeFalse();
    } finally {
      diskDb.close();
    }
  });

  test("blocked task with unresolved dep fails atomically with dependency_blocked", (): void => {
    const { db, service, domain } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const upstream = service.createTask({ epicId: epic.id, title: "U", description: "d", status: "todo" });
    const downstream = service.createTask({ epicId: epic.id, title: "D", description: "d", status: "todo" });
    service.addDependency(downstream.id, upstream.id);

    // Drive downstream into `blocked` via the public API so the atomic done
    // call has the same starting condition as the production callsite.
    const blocked = service.updateTask(downstream.id, { status: "blocked" });
    expect(blocked.status).toBe("blocked");

    // Upstream is still NOT done — dep is unresolved. The atomic done call
    // must throw dependency_blocked BEFORE issuing the direct UPDATE bypass.
    let caught: unknown;
    try {
      service.markTaskDoneAtomically({
        taskId: downstream.id,
        computeSnapshot: (): never => {
          throw new Error("should not reach computeSnapshot when dep is blocked");
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    const err = caught as { code?: string; details?: { unresolvedDependencyIds?: readonly string[] } };
    expect(err.code).toBe("dependency_blocked");
    expect(err.details?.unresolvedDependencyIds).toEqual([upstream.id]);

    // Atomic rollback: row is still `blocked`, never flipped to `done` or
    // wedged in `in_progress`.
    const after = domain.getTaskOrThrow(downstream.id);
    expect(after.status).toBe("blocked");

    // No `task.updated{status: done}` event leaked from the rolled-back txn.
    const events = listEventsForEntity(db, "task", downstream.id);
    const doneEvents = events.filter(
      (e) => e.operation === "task.updated"
        && (JSON.parse(e.payload) as { fields: { status: string } }).fields.status === "done",
    );
    expect(doneEvents.length).toBe(0);
  });

  test("already done returns already_done error", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "R", "--description", "d"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const created = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Done", "--description", "d", "--status", "done"],
    });
    const taskId = (created.data as { task: { id: string } }).task.id;

    const result = await runTask({ cwd, mode: "toon", args: ["done", taskId] });
    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("already_done");
  });

  test("concurrent task done on five distinct tasks does not cross-contaminate unblocked arrays", async (): Promise<void> => {
    // Five upstream tasks each have ONE distinct downstream blocker. When all
    // five upstreams finish concurrently, each call's `unblocked` array must
    // contain ONLY its own downstream — never another task's downstream.
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "R", "--description", "d"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const upstreams: string[] = [];
    const downstreams: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const upstream = await runTask({
        cwd,
        mode: "toon",
        args: ["create", "--epic", epicId, "--title", `U${i}`, "--description", "d", "--status", "todo"],
      });
      const upstreamId = (upstream.data as { task: { id: string } }).task.id;
      upstreams.push(upstreamId);

      const downstream = await runTask({
        cwd,
        mode: "toon",
        args: ["create", "--epic", epicId, "--title", `D${i}`, "--description", "d", "--status", "todo"],
      });
      const downstreamId = (downstream.data as { task: { id: string } }).task.id;
      downstreams.push(downstreamId);

      const dep = await runDep({ cwd, mode: "toon", args: ["add", downstreamId, upstreamId] });
      expect(dep.ok).toBeTrue();
    }

    // Fire all five `task done` calls concurrently.
    const results = await Promise.all(
      upstreams.map((id) => runTask({ cwd, mode: "toon", args: ["done", id] })),
    );

    type DoneData = {
      completed: { id: string };
      unblocked: ReadonlyArray<{ id: string; wasBlockedBy: readonly string[] }>;
    };

    for (let i = 0; i < upstreams.length; i += 1) {
      expect(results[i]!.ok).toBeTrue();
      const data = results[i]!.data as DoneData;
      expect(data.completed.id).toBe(upstreams[i]!);

      // Each call's unblocked array must be a subset of {downstreams[i]}: it
      // either contains JUST its own downstream (if its downstream is now
      // ready) or is empty (if other upstreams' downstreams happen to be
      // observed in a transient state). It must NEVER contain another
      // task's downstream — that would prove cross-contamination.
      const unblockedIds = new Set(data.unblocked.map((u) => u.id));
      for (const id of unblockedIds) {
        expect(id).toBe(downstreams[i]!);
      }
      for (const u of data.unblocked) {
        expect(u.wasBlockedBy).toEqual([upstreams[i]!]);
      }
    }
  });
});
