/** Read-only reverse queries over the desktop's outbound HTTPS long poll. */
import { randomUUID } from "node:crypto";

export interface RelayCommand { id: string; kind: "search" | "detail"; value: unknown }
interface Pending {
  node: string; command: RelayCommand; delivered: boolean;
  resolve(value: unknown): void; reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>; cleanup(): void;
}

export class PeerRelay {
  private pending = new Map<string, Pending>();
  private waiter?: { node: string; resolve(value: RelayCommand[]): void; timer: ReturnType<typeof setTimeout> };
  private lastPeer?: { node: string; seenAt: number };

  peer(): string | undefined {
    return this.lastPeer && Date.now() - this.lastPeer.seenAt < 30_000 ? this.lastPeer.node : undefined;
  }

  async request(kind: RelayCommand["kind"], value: unknown, signal?: AbortSignal): Promise<unknown> {
    const node = this.peer();
    if (!node || this.pending.size >= 16) throw new Error("Reverse peer unavailable");
    if (signal?.aborted) throw new Error("Reverse request cancelled");
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => finish(new Error("Reverse request cancelled"));
      const finish = (error?: Error, response?: unknown) => {
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); pending.cleanup();
        if (error) reject(error); else resolve(response);
      };
      const timer = setTimeout(() => finish(new Error("Reverse query timed out")), 2_600);
      timer.unref();
      this.pending.set(id, { node, command: { id, kind, value }, delivered: false,
        resolve: response => finish(undefined, response), reject: error => finish(error), timer,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } });
      signal?.addEventListener("abort", abort, { once: true });
      if (this.waiter?.node === node) this.flush();
    });
  }

  async poll(node: string): Promise<RelayCommand[]> {
    this.lastPeer = { node, seenAt: Date.now() };
    if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter.resolve([]); this.waiter = undefined; }
    const commands = this.take(node);
    if (commands.length) return commands;
    return new Promise(resolve => {
      const timer = setTimeout(() => { if (this.waiter?.timer === timer) this.waiter = undefined; resolve([]); }, 10_000);
      timer.unref(); this.waiter = { node, resolve, timer };
    });
  }

  results(node: string, results: unknown): void {
    if (!Array.isArray(results) || results.length > 16) throw new Error("Invalid reverse results");
    for (const result of results) {
      if (!result || typeof result !== "object" || typeof result.id !== "string") throw new Error("Invalid reverse result");
      const pending = this.pending.get(result.id);
      if (!pending || pending.node !== node || !pending.delivered) continue;
      if (result.ok === true) pending.resolve(result.value);
      else pending.reject(new Error("Reverse peer query failed"));
    }
  }

  stop(): void {
    if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter.resolve([]); this.waiter = undefined; }
    for (const pending of this.pending.values()) pending.reject(new Error("Peer stopped"));
    this.lastPeer = undefined;
  }

  private take(node: string): RelayCommand[] {
    const found: RelayCommand[] = [];
    for (const pending of this.pending.values()) if (pending.node === node && !pending.delivered && found.length < 4) {
      pending.delivered = true; found.push(pending.command);
    }
    return found;
  }
  private flush(): void {
    const waiter = this.waiter; if (!waiter) return;
    this.waiter = undefined; clearTimeout(waiter.timer); waiter.resolve(this.take(waiter.node));
  }
}
