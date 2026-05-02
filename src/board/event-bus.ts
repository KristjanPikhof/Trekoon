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
  markInProcessWrite(timestamp?: number): void;
  subscribe(listener: BoardEventListener): () => void;
  readonly lastInProcessWriteAt: number;
  readonly subscriberCount: number;
  close(): void;
}

export function createBoardEventBus(): BoardEventBus {
  const listeners = new Set<BoardEventListener>();
  let nextId = 1;
  let closed = false;
  let lastInProcessWriteAt = 0;

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
    markInProcessWrite(timestamp = Date.now()): void {
      lastInProcessWriteAt = timestamp;
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
    close(): void {
      closed = true;
      listeners.clear();
    },
  };
}
