import type { DshLiveWindow } from "./types.ts";

interface Subscription {
  controller: AbortController;
  task: Promise<void>;
  failures: number;
}

/** Wait without retaining timers after a subscription is cancelled. */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Maintain bounded Host follow windows independently; durable recovery remains the observer's job. */
export class DshLiveSubscriptions {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly tasks = new Set<Promise<void>>();

  constructor(
    private readonly follow: (sessionId: string, signal: AbortSignal) => Promise<DshLiveWindow>,
    private readonly onCursor: (sessionId: string, cursor: number) => void,
    private readonly jitterSource: () => number = Math.random,
  ) {}

  /** Discover new sessions and cancel subscriptions for sessions no longer listed. */
  sync(sessionIds: string[]): void {
    const wanted = new Set(sessionIds);
    for (const [id, subscription] of this.subscriptions) {
      if (!wanted.has(id)) {
        subscription.controller.abort();
        this.subscriptions.delete(id);
      }
    }
    for (const id of wanted) {
      if (this.subscriptions.has(id)) continue;
      const subscription: Subscription = {
        controller: new AbortController(), task: Promise.resolve(), failures: 0,
      };
      this.subscriptions.set(id, subscription);
      subscription.task = this.run(id, subscription);
      this.tasks.add(subscription.task);
      void subscription.task.then(() => this.tasks.delete(subscription.task));
    }
  }

  /** Abort all windows, including removed sessions, and drain before SQLite can close. */
  async stop(): Promise<void> {
    for (const subscription of this.subscriptions.values()) subscription.controller.abort();
    this.subscriptions.clear();
    await Promise.allSettled([...this.tasks]);
  }

  /** Report active and reconnecting subscriptions without leaking Host error contents. */
  getStatus(): { active: number; reconnecting: number } {
    return {
      active: this.subscriptions.size,
      reconnecting: [...this.subscriptions.values()].filter((item) => item.failures > 0).length,
    };
  }

  /** Reopen each single-event window; back off independently on Host failure. */
  private async run(sessionId: string, subscription: Subscription): Promise<void> {
    const signal = subscription.controller.signal;
    while (!signal.aborted) {
      try {
        const window = await this.follow(sessionId, signal);
        if (signal.aborted) break;
        subscription.failures = 0;
        this.onCursor(sessionId, window.observed ? window.event.seq : window.cursor);
        // A Host returning an empty window immediately must not produce a busy loop.
        if (!window.observed) await pause(100, signal);
      } catch {
        if (signal.aborted) break;
        subscription.failures++;
        const base = Math.min(1_000 * 2 ** Math.min(subscription.failures - 1, 6), 60_000);
        const jitter = 0.8 + 0.4 * Math.max(0, Math.min(1, this.jitterSource()));
        await pause(Math.min(Math.round(base * jitter), 60_000), signal);
      }
    }
  }
}
