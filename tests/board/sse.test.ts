import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { startBoardServer } from "../../src/board/server";
import { createBoardApiHandler } from "../../src/board/routes";
import { createBoardEventBus } from "../../src/board/event-bus";
import { resolveStoragePaths } from "../../src/storage/path";
import { openTrekoonDatabase } from "../../src/storage/database";
import { MutationService } from "../../src/domain/mutation-service";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-board-sse-"));
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
  readonly id: string | null;
}

async function readSseFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expectedCount: number,
  timeoutMs = 4000,
): Promise<readonly SseFrame[]> {
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";

  const deadline = Date.now() + timeoutMs;

  while (frames.length < expectedCount) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out waiting for SSE frames; got ${frames.length}/${expectedCount}: ${buffer}`);
    }

    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) => {
      setTimeout(() => resolve({ done: true, value: undefined }), remainingMs);
    });

    const result = await Promise.race([readPromise, timeoutPromise]);
    if (result.done) {
      throw new Error(`SSE stream closed before receiving ${expectedCount} frames`);
    }

    buffer += decoder.decode(result.value, { stream: true });

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1 && frames.length < expectedCount) {
      const rawFrame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      separatorIndex = buffer.indexOf("\n\n");

      if (rawFrame.startsWith(":")) {
        // Heartbeat / comment line - skip.
        continue;
      }

      let event = "message";
      let dataLine = "";
      let id: string | null = null;
      for (const line of rawFrame.split("\n")) {
        if (line.startsWith("event: ")) {
          event = line.slice("event: ".length);
        } else if (line.startsWith("data: ")) {
          dataLine = line.slice("data: ".length);
        } else if (line.startsWith("id: ")) {
          id = line.slice("id: ".length);
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

      frames.push({ event, data: parsedData, id });
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

describe("board SSE snapshot stream", (): void => {
  test("requires authentication", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);

    const boardServer = startBoardServer({ cwd: workspace, token: "stream-token" });

    try {
      const response = await fetch(`${boardServer.origin}/api/snapshot/stream`);
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("unauthorized");
    } finally {
      boardServer.stop();
    }
  });

  test("delivers initial snapshot then snapshotDelta events to multiple clients", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);

    const boardServer = startBoardServer({ cwd: workspace, token: "multi-client-token" });

    try {
      // Open two SSE clients with valid token.
      const controllers = [new AbortController(), new AbortController()];
      const responses = await Promise.all(
        controllers.map((controller) =>
          fetch(`${boardServer.origin}/api/snapshot/stream?token=multi-client-token`, {
            headers: { accept: "text/event-stream" },
            signal: controller.signal,
          }),
        ),
      );

      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(response.body).not.toBeNull();
      }

      const readers = responses.map((response) => {
        if (!response.body) {
          throw new Error("SSE response missing body");
        }
        return response.body.getReader();
      });

      // Consume initial snapshot frames so subsequent reads see deltas.
      const initialFrames = await Promise.all(readers.map((reader) => readSseFrames(reader, 1)));
      for (const frames of initialFrames) {
        expect(frames[0]?.event).toBe("snapshot");
        expect(frames[0]?.data).toMatchObject({ snapshot: expect.any(Object) });
      }

      // Trigger a write via API mutation -> POST /api/dependencies (won't work without seed data).
      // Easier: write an epic+task directly using domain, then simulate a route call by hitting PATCH /api/epics.
      const database = openTrekoonDatabase(workspace);
      try {
        const mutations = new MutationService(database.db, workspace);
        const epicResult = mutations.createEpic({ title: "SSE Epic", description: "Epic for SSE smoke." });
        const epicId = epicResult.id;
        // Trigger a board-side mutation that publishes a delta.
        const patchResponse = await fetch(`${boardServer.origin}/api/epics/${encodeURIComponent(epicId)}?token=multi-client-token`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "SSE Epic Renamed" }),
        });
        expect(patchResponse.status).toBe(200);
      } finally {
        database.close();
      }

      // Each reader should receive a snapshotDelta frame.
      const deltaFrames = await Promise.all(readers.map((reader) => readSseFrames(reader, 1)));
      for (const frames of deltaFrames) {
        expect(frames[0]?.event).toBe("snapshotDelta");
        expect(frames[0]?.data).toMatchObject({ snapshotDelta: expect.any(Object) });
        expect(frames[0]?.id).not.toBeNull();
      }

      for (const reader of readers) {
        await reader.cancel().catch(() => {});
      }
      for (const controller of controllers) {
        controller.abort();
      }
    } finally {
      boardServer.stop();
    }
  });

  test("coalesces snapshotDeltas behind the soft threshold so a slow client cannot OOM", async (): Promise<void> => {
    const cwd: string = createWorkspace();
    prepareBoardAssets(cwd);
    const storage = openTrekoonDatabase(cwd);
    const eventBus = createBoardEventBus();

    try {
      const handler = createBoardApiHandler({
        db: storage.db,
        cwd,
        token: "slow-client-token",
        eventBus,
      });
      const response = await handler(
        new Request("http://board.test/api/snapshot/stream?token=slow-client-token"),
      );
      expect(response.status).toBe(200);
      const body = response.body as ReadableStream<Uint8Array>;

      // 1 subscriber == this stream.
      expect(eventBus.subscriberCount).toBe(1);

      // Publish 100 deltas of ~50KB each. Without coalescing this would
      // accumulate ~5MB in the controller's internal queue. The route must
      // detect the slow consumer (no `pull` ever happens because the body
      // stream is never read) and switch to keeping only the latest delta —
      // the subscriber stays attached but memory stays bounded around the
      // soft cap.
      const filler = "x".repeat(50_000);
      for (let i = 0; i < 100; i += 1) {
        eventBus.publishSnapshotDelta({ filler, idx: i });
      }

      expect(eventBus.subscriberCount).toBe(1);
      await body.cancel().catch(() => {});
      expect(eventBus.subscriberCount).toBe(0);
    } finally {
      eventBus.close();
      storage.close();
    }
  });

  test("unsubscribes a slow client and emits an error frame when queued bytes pass the 1MB hard cap", async (): Promise<void> => {
    const cwd: string = createWorkspace();
    prepareBoardAssets(cwd);
    const storage = openTrekoonDatabase(cwd);
    const eventBus = createBoardEventBus();

    try {
      const handler = createBoardApiHandler({
        db: storage.db,
        cwd,
        token: "hard-cap-token",
        eventBus,
      });
      const response = await handler(
        new Request("http://board.test/api/snapshot/stream?token=hard-cap-token"),
      );
      expect(response.status).toBe(200);
      const body = response.body as ReadableStream<Uint8Array>;

      expect(eventBus.subscriberCount).toBe(1);

      // First delta is so large its single enqueue pushes the queue past the
      // 1MB hard cap on its own. The next enqueue (heartbeat, second delta)
      // will see queuedBytes >= SSE_MAX_QUEUED_BYTES and tear the stream
      // down. We trigger that via a second publish so the test runs
      // immediately rather than waiting on the heartbeat timer.
      const oversizedFiller = "x".repeat(1_500_000);
      eventBus.publishSnapshotDelta({ filler: oversizedFiller, kind: "first" });
      // Second publish: queuedBytes is now ≥ 1MB, so handleSnapshotDelta
      // calls closeWithError → cleanupTimers → unsubscribe.
      eventBus.publishSnapshotDelta({ filler: "x", kind: "trip" });

      expect(eventBus.subscriberCount).toBe(0);

      // The error frame is emitted before the close. Reading it off the
      // stream should yield the JSON payload our route formats.
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let combined = "";
      // Read until done or we see the stream_error event.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        combined += decoder.decode(value, { stream: true });
        if (combined.includes("event: stream_error")) {
          break;
        }
      }
      expect(combined).toContain("event: stream_error");
      expect(combined).toContain("\"code\":\"backpressure\"");
      await reader.cancel().catch(() => {});
    } finally {
      eventBus.close();
      storage.close();
    }
  });
});
