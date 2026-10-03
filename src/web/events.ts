import type { WebStore } from "./store.ts";

interface Connection { deviceId: string; controller: ReadableStreamDefaultController<Uint8Array>; dispose: () => void; }

/** Authenticated control-only event registry with bounded per-device connections. */
export class WebEvents {
  private readonly connections = new Set<Connection>();
  private readonly encoder = new TextEncoder();

  /** Read durable revocation/expiry during periodic liveness checks. */
  constructor(private readonly store: WebStore, private readonly heartbeatInterval: (tick: () => void) => ReturnType<typeof setInterval> = (tick) => setInterval(tick, 15000)) {}

  /** Open a stream after HTTP authentication; no credential or body is put in its URL. */
  open(deviceId: string, signal: AbortSignal): ReadableStream<Uint8Array> {
    if (this.connections.size >= 100 || [...this.connections].filter((item) => item.deviceId === deviceId).length >= 4) throw new Error("event_limit");
    let connection: Connection | null = null;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        let disposed = false;
        const dispose = () => {
          if (disposed) return; disposed = true;
          clearInterval(timer); signal.removeEventListener("abort", dispose);
          if (connection) this.connections.delete(connection);
          try { controller.close(); } catch { /* The client may already have canceled. */ }
        };
        const timer = this.heartbeatInterval(() => {
          const device = this.store.getDevice(deviceId);
          if (!device || device.revokedAt !== null || device.expiresAt <= Date.now()) { this.revoke(deviceId); return; }
          if (connection) this.enqueue(connection, ": heartbeat\n\n");
        });
        timer.unref();
        connection = { deviceId, controller, dispose }; this.connections.add(connection);
        signal.addEventListener("abort", dispose, { once: true });
        this.emit(connection, "settings_version", { version: this.store.getSettings().version });
        if (signal.aborted) dispose();
      },
      cancel: () => connection?.dispose(),
    });
  }

  /** Broadcast only a version, never private display data. */
  settingsChanged(version: number): void { for (const connection of this.connections) this.emit(connection, "settings_version", { version }); }

  /** Send revocation control and close all connections for the target device. */
  revoke(deviceId: string): void {
    for (const connection of [...this.connections]) if (connection.deviceId === deviceId) {
      this.emit(connection, "session_revoked", {}); connection.dispose();
    }
  }

  /** Stop all streams before closing the underlying database. */
  close(): void { for (const connection of [...this.connections]) connection.dispose(); }

  /** Encode a bounded control event, disposing slow clients instead of buffering forever. */
  private emit(connection: Connection, name: string, value: Record<string, number>): void {
    this.enqueue(connection, `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  }

  /** Apply the same buffer bound to both controls and periodic heartbeats. */
  private enqueue(connection: Connection, text: string): void {
    try {
      if ((connection.controller.desiredSize ?? 0) < -16) { connection.dispose(); return; }
      connection.controller.enqueue(this.encoder.encode(text));
    } catch { connection.dispose(); }
  }
}
