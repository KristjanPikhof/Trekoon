import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { runEpic } from "../../src/commands/epic";
import { runSubtask } from "../../src/commands/subtask";
import { runTask } from "../../src/commands/task";
import { MutationService } from "../../src/domain/mutation-service";
import { TrackerDomain } from "../../src/domain/tracker-domain";
import { migrateDatabase } from "../../src/storage/migrations";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-task-claim-"));
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

describe("task claim — domain layer (MutationService.claimTask)", (): void => {
  test("claim a todo task — sets status=in_progress and owner", (): void => {
    const { service, domain } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T", description: "d", status: "todo" });

    const result = service.claimTask({ taskId: task.id, owner: "agent-1" });

    expect(result.claimed).toBe(true);
    expect(result.currentOwner).toBe("agent-1");
    expect(result.currentStatus).toBe("in_progress");
    expect(result.task).toBeDefined();
    expect(result.task!.status).toBe("in_progress");
    expect(result.task!.owner).toBe("agent-1");

    const row = domain.getTaskOrThrow(task.id);
    expect(row.status).toBe("in_progress");
    expect(row.owner).toBe("agent-1");
  });

  test("claim a blocked task — sets status=in_progress and owner", (): void => {
    const { service, domain } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T", description: "d", status: "todo" });
    service.updateTask(task.id, { status: "blocked" });

    const result = service.claimTask({ taskId: task.id, owner: "agent-x" });

    expect(result.claimed).toBe(true);
    expect(result.currentOwner).toBe("agent-x");
    expect(result.currentStatus).toBe("in_progress");

    const row = domain.getTaskOrThrow(task.id);
    expect(row.status).toBe("in_progress");
    expect(row.owner).toBe("agent-x");
  });

  test("claim already in_progress by another owner — claimed=false", (): void => {
    const { service } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T", description: "d", status: "todo" });
    service.updateTask(task.id, { status: "in_progress", owner: "winner" });

    const result = service.claimTask({ taskId: task.id, owner: "loser" });

    expect(result.claimed).toBe(false);
    expect(result.currentOwner).toBe("winner");
    expect(result.currentStatus).toBe("in_progress");
    expect(result.task).toBeUndefined();
  });

  test("re-claim own in_progress task — claimed=false (already in_progress, not todo/blocked)", (): void => {
    // The SQL predicate allows re-claim only from todo/blocked with matching owner.
    // Once a task is in_progress, even the same owner must use task update to modify it.
    const { service } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T", description: "d", status: "todo" });
    service.updateTask(task.id, { status: "in_progress", owner: "agent-1" });

    const result = service.claimTask({ taskId: task.id, owner: "agent-1" });

    // The task is already in_progress, so it does NOT match status IN ('todo','blocked')
    // → claim fails. This is documented behavior: use task update to re-set fields.
    expect(result.claimed).toBe(false);
    expect(result.currentOwner).toBe("agent-1");
    expect(result.currentStatus).toBe("in_progress");
  });

  test("claim a done task — claimed=false", (): void => {
    const { service } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T", description: "d", status: "todo" });
    service.markTaskDoneAtomically({
      taskId: task.id,
      computeSnapshot: ({ completed }) => completed,
    });

    const result = service.claimTask({ taskId: task.id, owner: "agent-1" });

    expect(result.claimed).toBe(false);
    expect(result.currentStatus).toBe("done");
  });

  test("emits task.updated event when claim succeeds", (): void => {
    const { db, service } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T", description: "d", status: "todo" });

    service.claimTask({ taskId: task.id, owner: "agent-1" });

    const events = db
      .query<{ operation: string; payload: string }, [string, string]>(
        `SELECT operation, payload FROM events WHERE entity_kind = ? AND entity_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all("task", task.id);
    const updateEvents = events.filter((e) => e.operation === "task.updated");
    expect(updateEvents.length).toBeGreaterThanOrEqual(1);
    const last = updateEvents.at(-1)!;
    const payload = JSON.parse(last.payload) as { fields: { status: string; owner: string } };
    expect(payload.fields.status).toBe("in_progress");
    expect(payload.fields.owner).toBe("agent-1");
  });

  test("does NOT emit task.updated event when claim fails", (): void => {
    const { db, service } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T", description: "d", status: "todo" });
    service.updateTask(task.id, { status: "in_progress", owner: "winner" });
    const eventsBefore = db
      .query<{ count: number }, [string, string]>(
        `SELECT COUNT(*) as count FROM events WHERE entity_kind = ? AND entity_id = ? AND operation = 'task.updated'`,
      )
      .get("task", task.id)!.count;

    service.claimTask({ taskId: task.id, owner: "loser" });

    const eventsAfter = db
      .query<{ count: number }, [string, string]>(
        `SELECT COUNT(*) as count FROM events WHERE entity_kind = ? AND entity_id = ? AND operation = 'task.updated'`,
      )
      .get("task", task.id)!.count;
    expect(eventsAfter).toBe(eventsBefore); // no new event emitted
  });
});

describe("task claim — concurrency (5-way race)", (): void => {
  test("5 concurrent claimTask calls yield exactly one claimed=true", (): void => {
    const { service } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T", description: "d", status: "todo" });

    // bun:sqlite uses a single JS thread, so the "concurrency" here is
    // sequential calls from distinct owners on the same task. SQLite
    // BEGIN IMMEDIATE + the status IN ('todo','blocked') predicate ensures
    // exactly one succeeds regardless of interleaving.
    const owners = ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e"];
    const results = owners.map((owner) => service.claimTask({ taskId: task.id, owner }));

    const claimed = results.filter((r) => r.claimed);
    const notClaimed = results.filter((r) => !r.claimed);

    expect(claimed.length).toBe(1);
    expect(notClaimed.length).toBe(4);

    // Every loser reports the winner's owner
    const winner = claimed[0]!;
    for (const loser of notClaimed) {
      expect(loser.currentOwner).toBe(winner.currentOwner);
      expect(loser.currentStatus).toBe("in_progress");
    }
  });

  test("winner owner is one of the 5 callers", (): void => {
    const { service } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T", description: "d", status: "todo" });

    const owners = ["w1", "w2", "w3", "w4", "w5"];
    const results = owners.map((owner) => service.claimTask({ taskId: task.id, owner }));
    const winner = results.find((r) => r.claimed)!;

    expect(owners).toContain(winner.currentOwner ?? "");
  });
});

describe("subtask claim — domain layer (MutationService.claimSubtask)", (): void => {
  test("claim a todo subtask — happy path", (): void => {
    const { service, domain } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T", description: "d" });
    const subtask = service.createSubtask({ taskId: task.id, title: "S", description: "d", status: "todo" });

    const result = service.claimSubtask({ subtaskId: subtask.id, owner: "agent-sub" });

    expect(result.claimed).toBe(true);
    expect(result.currentOwner).toBe("agent-sub");
    expect(result.currentStatus).toBe("in_progress");
    expect(result.subtask).toBeDefined();

    const row = domain.getSubtaskOrThrow(subtask.id);
    expect(row.status).toBe("in_progress");
    expect(row.owner).toBe("agent-sub");
  });

  test("claim subtask by another owner — claimed=false", (): void => {
    const { service } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T", description: "d" });
    const subtask = service.createSubtask({ taskId: task.id, title: "S", description: "d", status: "todo" });
    service.updateSubtask(subtask.id, { status: "in_progress", owner: "first" });

    const result = service.claimSubtask({ subtaskId: subtask.id, owner: "second" });

    expect(result.claimed).toBe(false);
    expect(result.currentOwner).toBe("first");
    expect(result.currentStatus).toBe("in_progress");
  });
});

describe("task claim — CLI subcommand", (): void => {
  test("task claim via runTask CLI function — claimed=true from todo", async (): Promise<void> => {
    const cwd = createWorkspace();

    // Bootstrap storage via CLI (runEpic calls openTrekoonDatabase which creates .trekoon/)
    const epicRes = await runEpic({ cwd, mode: "toon", args: ["create", "--title", "E", "--description", "d"] });
    const epicId = (epicRes.data as { epic: { id: string } }).epic.id;

    const taskRes = await runTask({ cwd, mode: "toon", args: ["create", "--epic", epicId, "--title", "T", "--description", "d"] });
    const taskId = (taskRes.data as { task: { id: string } }).task.id;

    const result = await runTask({
      cwd,
      mode: "toon",
      args: ["claim", taskId, "--owner", "cli-runner"],
    });

    expect(result.ok).toBe(true);
    expect(result.command).toBe("task.claim");
    const data = result.data as { claimed: boolean; currentOwner: string; currentStatus: string; task: { id: string } };
    expect(data.claimed).toBe(true);
    expect(data.currentOwner).toBe("cli-runner");
    expect(data.currentStatus).toBe("in_progress");
    expect(data.task.id).toBe(taskId);
  });

  test("task claim — missing --owner returns invalid_input", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicRes = await runEpic({ cwd, mode: "toon", args: ["create", "--title", "E", "--description", "d"] });
    const epicId = (epicRes.data as { epic: { id: string } }).epic.id;
    const taskRes = await runTask({ cwd, mode: "toon", args: ["create", "--epic", epicId, "--title", "T", "--description", "d"] });
    const taskId = (taskRes.data as { task: { id: string } }).task.id;

    const result = await runTask({
      cwd,
      mode: "toon",
      args: ["claim", taskId],
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_input");
  });

  test("task claim — claimed=false when already owned by another", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicRes = await runEpic({ cwd, mode: "toon", args: ["create", "--title", "E", "--description", "d"] });
    const epicId = (epicRes.data as { epic: { id: string } }).epic.id;
    const taskRes = await runTask({ cwd, mode: "toon", args: ["create", "--epic", epicId, "--title", "T", "--description", "d"] });
    const taskId = (taskRes.data as { task: { id: string } }).task.id;
    // First, claim it
    await runTask({ cwd, mode: "toon", args: ["claim", taskId, "--owner", "existing-owner"] });

    const result = await runTask({
      cwd,
      mode: "toon",
      args: ["claim", taskId, "--owner", "new-owner"],
    });

    expect(result.ok).toBe(true);
    expect(result.command).toBe("task.claim");
    const data = result.data as { claimed: boolean; currentOwner: string };
    expect(data.claimed).toBe(false);
    expect(data.currentOwner).toBe("existing-owner");
  });

  test("task claim — done task returns claimed=false", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicRes = await runEpic({ cwd, mode: "toon", args: ["create", "--title", "E", "--description", "d"] });
    const epicId = (epicRes.data as { epic: { id: string } }).epic.id;
    const taskRes = await runTask({ cwd, mode: "toon", args: ["create", "--epic", epicId, "--title", "T", "--description", "d"] });
    const taskId = (taskRes.data as { task: { id: string } }).task.id;
    await runTask({ cwd, mode: "toon", args: ["done", taskId] });

    const result = await runTask({
      cwd,
      mode: "toon",
      args: ["claim", taskId, "--owner", "agent-1"],
    });

    expect(result.ok).toBe(true);
    const data = result.data as { claimed: boolean; currentStatus: string };
    expect(data.claimed).toBe(false);
    expect(data.currentStatus).toBe("done");
  });
});

describe("subtask claim — CLI subcommand", (): void => {
  test("subtask claim <id> --owner: happy path", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicRes = await runEpic({ cwd, mode: "toon", args: ["create", "--title", "E", "--description", "d"] });
    const epicId = (epicRes.data as { epic: { id: string } }).epic.id;
    const taskRes = await runTask({ cwd, mode: "toon", args: ["create", "--epic", epicId, "--title", "T", "--description", "d"] });
    const taskId = (taskRes.data as { task: { id: string } }).task.id;
    const subtaskRes = await runSubtask({ cwd, mode: "toon", args: ["create", "--task", taskId, "--title", "S", "--description", "d"] });
    const subtaskId = (subtaskRes.data as { subtask: { id: string } }).subtask.id;

    const result = await runSubtask({
      cwd,
      mode: "toon",
      args: ["claim", subtaskId, "--owner", "sub-agent"],
    });

    expect(result.ok).toBe(true);
    expect(result.command).toBe("subtask.claim");
    const data = result.data as { claimed: boolean; currentOwner: string; currentStatus: string; subtask: { id: string } };
    expect(data.claimed).toBe(true);
    expect(data.currentOwner).toBe("sub-agent");
    expect(data.currentStatus).toBe("in_progress");
    expect(data.subtask.id).toBe(subtaskId);
  });
});
