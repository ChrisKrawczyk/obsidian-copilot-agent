import { describe, expect, test, vi } from "vitest";
import {
  delayForAttempt,
  MCP_RECONNECT_MAX_DELAY_MS,
  McpReconnectPolicy,
} from "./McpReconnectPolicy";

describe("McpReconnectPolicy", () => {
  test("uses 1/2/4/8/16/32 second schedule then caps at 60 seconds", () => {
    expect(Array.from({ length: 8 }, (_, i) => delayForAttempt(i))).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      32_000,
      MCP_RECONNECT_MAX_DELAY_MS,
      MCP_RECONNECT_MAX_DELAY_MS,
    ]);
  });

  test("reset on successful initialize returns to first delay", () => {
    const policy = new McpReconnectPolicy({ onAttempt: vi.fn() });
    policy.recordFailure(new Error("a"));
    expect(policy.nextDelayForTest()).toBe(2_000);
    policy.recordSuccess();
    expect(policy.nextDelayForTest()).toBe(1_000);
    expect(policy.status()).toBe("idle");
  });

  test("five failures within five minutes enter crashloop", () => {
    let now = 0;
    const statuses: string[] = [];
    const policy = new McpReconnectPolicy({
      now: () => now,
      onAttempt: vi.fn(),
      onStatus: (status) => { statuses.push(status); },
    });
    for (let i = 0; i < 5; i += 1) {
      policy.recordFailure(new Error("boom"));
      now += 30_000;
    }
    expect(policy.status()).toBe("crashloop");
    expect(statuses).toContain("crashloop");
  });

  test("failures outside five minute window do not crashloop", () => {
    let now = 0;
    const policy = new McpReconnectPolicy({ now: () => now, onAttempt: vi.fn() });
    for (let i = 0; i < 5; i += 1) {
      policy.recordFailure(new Error("boom"));
      now += 301_000;
    }
    expect(policy.status()).toBe("reconnecting");
  });

  test("manual reconnect resets crashloop state", async () => {
    const policy = new McpReconnectPolicy({ onAttempt: vi.fn(async () => undefined) });
    for (let i = 0; i < 5; i += 1) policy.recordFailure(new Error("boom"));
    expect(policy.status()).toBe("crashloop");
    await policy.manualReconnect();
    expect(policy.status()).toBe("idle");
  });

  test("cancel clears armed reconnect timer for disable/remove/unload", async () => {
    vi.useFakeTimers();
    try {
      const attempt = vi.fn();
      const policy = new McpReconnectPolicy({ onAttempt: attempt });
      policy.recordFailure(new Error("boom"));
      expect(policy.isArmed()).toBe(true);
      policy.cancel();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempt).not.toHaveBeenCalled();
      expect(policy.isArmed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("manual reconnect cancels armed timer and starts exactly one immediate attempt", async () => {
    vi.useFakeTimers();
    try {
      const attempt = vi.fn(async () => undefined);
      const policy = new McpReconnectPolicy({ onAttempt: attempt });
      policy.recordFailure(new Error("boom"));
      await policy.manualReconnect();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(policy.status()).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });
});
