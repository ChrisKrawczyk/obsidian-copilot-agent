import { describe, expect, test, vi } from "vitest";
import { normalizeServerId } from "./McpIdentity";
import { McpNotificationQueue } from "./McpNotificationQueue";

describe("McpNotificationQueue", () => {
  test("three notifications during one in-flight call coalesce to one post-call refresh", async () => {
    const serverId = normalizeServerId("s");
    const refresh = vi.fn(async () => undefined);
    const queue = new McpNotificationQueue({ refresh });
    queue.beginCall(serverId);
    queue.notifyListChanged(serverId);
    queue.notifyListChanged(serverId);
    queue.notifyListChanged(serverId);
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    queue.endCall(serverId);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("refresh is atomic from the queue perspective", async () => {
    const serverId = normalizeServerId("s");
    let release!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const queue = new McpNotificationQueue({ refresh });
    queue.notifyListChanged(serverId);
    queue.notifyListChanged(serverId);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test("refresh failure is swallowed so callers preserve previous inventory", async () => {
    const serverId = normalizeServerId("s");
    const refresh = vi.fn(async () => { throw new Error("refresh failed"); });
    const queue = new McpNotificationQueue({ refresh });
    queue.notifyListChanged(serverId);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    queue.beginCall(serverId);
    queue.notifyListChanged(serverId);
    queue.endCall(serverId);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test("coalescing is per server", async () => {
    const a = normalizeServerId("a");
    const b = normalizeServerId("b");
    const refresh = vi.fn(async () => undefined);
    const queue = new McpNotificationQueue({ refresh });
    queue.beginCall(a);
    queue.notifyListChanged(a);
    queue.notifyListChanged(b);
    await flush();
    expect(refresh).toHaveBeenCalledWith(b);
    expect(refresh).not.toHaveBeenCalledWith(a);
    queue.endCall(a);
    await flush();
    expect(refresh).toHaveBeenCalledWith(a);
  });

  test("cancel removes pending list_changed work", async () => {
    const serverId = normalizeServerId("s");
    const refresh = vi.fn(async () => undefined);
    const queue = new McpNotificationQueue({ refresh });
    queue.beginCall(serverId);
    queue.notifyListChanged(serverId);
    queue.cancel(serverId);
    queue.endCall(serverId);
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
}
