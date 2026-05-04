/**
 * Board event bus.
 *
 * Per-server-instance pub/sub used to broadcast snapshot deltas to SSE
 * subscribers (browser tabs). Publishers (board route handlers, future WAL
 * watcher) call publish; subscribers receive the JSON-serializable payload.
 */

export interface BoardDeltaEvent {
  readonly type: "snapshotDelta";
  readonly id: number;
  readonly snapshotDelta: Record<string, unknown>;
}

export type BoardEvent = BoardDeltaEvent;

export type BoardEventListener = (event: BoardEvent) => void;

export interface BoardEventBus {
  publishSnapshotDelta(snapshotDelta: Record<string, unknown>): BoardDeltaEvent;
  markInProcessWrite(timestamp?: number, snapshotDelta?: Record<string, unknown>): void;
  subscribe(listener: BoardEventListener): () => void;
  readonly lastInProcessWriteAt: number;
  readonly lastInProcessSnapshotDelta: Record<string, unknown> | null;
  readonly subscriberCount: number;
  close(): void;
}

export function createBoardEventBus(): BoardEventBus {
  const listeners = new Set<BoardEventListener>();
  let nextId = 1;
  let closed = false;
  let lastInProcessWriteAt = 0;
  let lastInProcessSnapshotDelta: Record<string, unknown> | null = null;

  return {
    publishSnapshotDelta(snapshotDelta: Record<string, unknown>): BoardDeltaEvent {
      const event: BoardDeltaEvent = {
        type: "snapshotDelta",
        id: nextId++,
        snapshotDelta,
      };

      if (closed) {
        return event;
      }

      // Snapshot to allow listeners to unsubscribe during dispatch.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // Listener errors must not block other subscribers.
        }
      }

      return event;
    },
    markInProcessWrite(timestamp = Date.now(), snapshotDelta: Record<string, unknown> | undefined = undefined): void {
      lastInProcessWriteAt = timestamp;
      lastInProcessSnapshotDelta = snapshotDelta ?? null;
    },
    subscribe(listener: BoardEventListener): () => void {
      if (closed) {
        return () => {};
      }

      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get subscriberCount(): number {
      return listeners.size;
    },
    get lastInProcessWriteAt(): number {
      return lastInProcessWriteAt;
    },
    get lastInProcessSnapshotDelta(): Record<string, unknown> | null {
      return lastInProcessSnapshotDelta;
    },
    close(): void {
      closed = true;
      listeners.clear();
    },
  };
}
