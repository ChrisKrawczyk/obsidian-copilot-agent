import type { McpServerId } from "./McpTypes";

export interface McpNotificationQueueOptions {
  refresh: (serverId: McpServerId) => Promise<void>;
}

interface ServerQueueState {
  inFlightCalls: number;
  pendingListChanged: boolean;
  refreshing: boolean;
}

export class McpNotificationQueue {
  private readonly states = new Map<McpServerId, ServerQueueState>();

  constructor(private readonly options: McpNotificationQueueOptions) {}

  beginCall(serverId: McpServerId): void {
    this.state(serverId).inFlightCalls += 1;
  }

  endCall(serverId: McpServerId): void {
    const state = this.state(serverId);
    state.inFlightCalls = Math.max(0, state.inFlightCalls - 1);
    if (state.inFlightCalls === 0 && state.pendingListChanged) void this.flush(serverId);
  }

  notifyListChanged(serverId: McpServerId): void {
    const state = this.state(serverId);
    state.pendingListChanged = true;
    if (state.inFlightCalls === 0) void this.flush(serverId);
  }

  cancel(serverId?: McpServerId): void {
    if (serverId) {
      this.states.delete(serverId);
      return;
    }
    this.states.clear();
  }

  private async flush(serverId: McpServerId): Promise<void> {
    const state = this.state(serverId);
    if (state.refreshing || state.inFlightCalls > 0 || !state.pendingListChanged) return;
    state.pendingListChanged = false;
    state.refreshing = true;
    try {
      await this.options.refresh(serverId);
    } catch {
      // Refresh failure handling is owned by McpManager so previous inventory can be preserved atomically.
    } finally {
      state.refreshing = false;
      if (state.pendingListChanged && state.inFlightCalls === 0) void this.flush(serverId);
    }
  }

  private state(serverId: McpServerId): ServerQueueState {
    let state = this.states.get(serverId);
    if (!state) {
      state = { inFlightCalls: 0, pendingListChanged: false, refreshing: false };
      this.states.set(serverId, state);
    }
    return state;
  }
}
