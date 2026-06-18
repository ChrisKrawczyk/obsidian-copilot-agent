import type { McpRuntimeStatus } from "./McpTypes";

export const MCP_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000] as const;
export const MCP_RECONNECT_MAX_DELAY_MS = 60_000;
export const MCP_CRASHLOOP_WINDOW_MS = 5 * 60_000;
export const MCP_CRASHLOOP_ATTEMPTS = 5;

export interface McpReconnectPolicyOptions {
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  now?: () => number;
  onAttempt: () => void | Promise<void>;
  onStatus?: (status: McpRuntimeStatus, lastError?: string) => void | Promise<void>;
}

export class McpReconnectPolicy {
  private failures: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attemptIndex = 0;
  private state: "idle" | "reconnecting" | "crashloop" = "idle";
  private runningImmediate = false;

  constructor(private readonly options: McpReconnectPolicyOptions) {}

  recordSuccess(): void {
    this.cancel();
    this.failures = [];
    this.attemptIndex = 0;
    this.state = "idle";
  }

  recordFailure(error: unknown): void {
    const now = this.options.now?.() ?? Date.now();
    this.failures = [...this.failures.filter((t) => now - t <= MCP_CRASHLOOP_WINDOW_MS), now];
    if (this.failures.length >= MCP_CRASHLOOP_ATTEMPTS) {
      this.cancel();
      this.state = "crashloop";
      void this.options.onStatus?.("crashloop", "MCP server entered crashloop after 5 failures in 5 minutes.");
      return;
    }
    this.armNext(error);
  }

  manualReconnect(): Promise<void> {
    this.cancel();
    this.failures = [];
    this.attemptIndex = 0;
    this.state = "idle";
    if (this.runningImmediate) return Promise.resolve();
    this.runningImmediate = true;
    return Promise.resolve(this.options.onAttempt()).finally(() => {
      this.runningImmediate = false;
    });
  }

  cancel(): void {
    if (this.timer) {
      (this.options.clearTimeout ?? clearTimeout)(this.timer);
      this.timer = null;
    }
    if (this.state !== "crashloop") this.state = "idle";
  }

  status(): "idle" | "reconnecting" | "crashloop" {
    return this.state;
  }

  isArmed(): boolean {
    return this.timer !== null;
  }

  nextDelayForTest(): number {
    return delayForAttempt(this.attemptIndex);
  }

  private armNext(error: unknown): void {
    this.cancel();
    this.state = "reconnecting";
    const delay = delayForAttempt(this.attemptIndex++);
    void this.options.onStatus?.("reconnecting", error instanceof Error ? error.message : String(error));
    this.timer = (this.options.setTimeout ?? setTimeout)(() => {
      this.timer = null;
      void Promise.resolve(this.options.onAttempt()).catch((err) => this.recordFailure(err));
    }, delay);
  }
}

export function delayForAttempt(index: number): number {
  return index < MCP_RECONNECT_DELAYS_MS.length ? MCP_RECONNECT_DELAYS_MS[index] : MCP_RECONNECT_MAX_DELAY_MS;
}
