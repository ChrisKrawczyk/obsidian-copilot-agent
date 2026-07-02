import { defineTool, type Tool } from "@github/copilot-sdk";
import type { McpManager } from "./McpManager";
import type { McpToolRegistrySnapshot } from "./McpToolRegistry";
import { normalizeMcpArgs, normalizeMcpResult } from "./normalizeMcpResult";
import { MCP_CALL_TIMEOUT_MS } from "./McpServerRuntime";
import { redactSensitive } from "./redactSensitive";

export interface McpToolBridgeOptions {
  manager: Pick<McpManager, "callTool"> & Partial<Pick<McpManager, "statusSnapshot">>;
  approval?: (toolCall: { syntheticId: string; args: unknown }) => Promise<"approved" | "rejected"> | "approved" | "rejected";
  callTimeoutMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export function createMcpSdkTools(snapshot: McpToolRegistrySnapshot, options: McpToolBridgeOptions): Tool[] {
  return snapshot.tools.map((entry) =>
    defineTool(entry.syntheticId, {
      description: entry.description ?? `MCP tool ${entry.toolName} from ${entry.serverName}`,
      parameters: entry.inputSchema as Parameters<typeof defineTool>[1]["parameters"],
      skipPermission: false,
      handler: async (args: unknown, invocation?: unknown) => {
        const signal = invocation && typeof invocation === "object" && "signal" in invocation
          ? (invocation as { signal?: AbortSignal }).signal
          : undefined;
        const decision = await Promise.resolve(options.approval?.({ syntheticId: entry.syntheticId, args }) ?? "approved");
        if (decision !== "approved") {
          const err = new Error("MCP tool call rejected by approval policy.");
          (err as Error & { cancelled?: boolean }).cancelled = true;
          throw err;
        }
        const statuses = options.manager.statusSnapshot?.();
        const status = statuses?.find((snapshot) => snapshot.id === entry.serverId);
        const unavailable = (reason: string): Error => {
          const err = new Error(
            `MCP server "${entry.serverName}" is ${reason}. All tools from this server (including "${entry.toolName}") are unavailable in this session. ` +
              "Do not retry these tools — inform the user that the server needs to be re-enabled in plugin settings.",
          );
          err.name = "CancelledError";
          (err as Error & { cancelled?: boolean }).cancelled = true;
          return err;
        };
        if (statuses && (!status || status.status !== "connected")) throw unavailable("disabled, removed, or disconnected");
        if ((status as typeof status & { enabled?: boolean } | undefined)?.enabled === false) {
          throw unavailable("disabled");
        }
        const callArgs = args && typeof args === "object" ? args as Record<string, unknown> : {};
        const raw = await withCancellationAndLateDebug(
          signal
            ? options.manager.callTool(entry.serverId, entry.toolName, callArgs, { signal } as never)
            : options.manager.callTool(entry.serverId, entry.toolName, callArgs),
          options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
          "MCP tool call timed out.",
          options.setTimeout,
          options.clearTimeout,
          signal,
          entry.syntheticId,
        );
        const normalized = normalizeMcpResult(raw);
        if (normalized.isError) {
          // Industry pattern (bastani/atomic, kimchi, inkeep, MCP spec 2025-06-18 §"Error Handling"):
          // return tool-execution errors as content, not as thrown exceptions. This guarantees the
          // error text is rendered in chat (tool return values always render), lets the LLM read
          // the diagnostic and self-correct or explain to the user, and avoids depending on
          // downstream SDK error-propagation to preserve `error.message`. Hard failures
          // (server disabled/disconnected, cancellation, timeout) remain thrown above — those are
          // invocation failures, not tool-execution errors.
          const kind = normalized.errorKind === "json-rpc" ? "MCP JSON-RPC error" : "MCP tool reported error";
          const body = normalized.content && normalized.content.length > 0
            ? normalized.content
            : "(no error details returned by the server)";
          return `Error: ${kind}: ${body}`;
        }
        return normalized.content;
      },
    }),
  ) as unknown as Tool[];
}

export function mcpArgsPreview(args: unknown): string {
  return normalizeMcpArgs(args);
}

function cancelledError(message: string): Error {
  const err = new Error(message);
  err.name = "CancelledError";
  (err as Error & { cancelled?: boolean }).cancelled = true;
  return err;
}

function withCancellationAndLateDebug<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  setTimer: typeof setTimeout = setTimeout,
  clearTimer: typeof clearTimeout = clearTimeout,
  signal?: AbortSignal,
  syntheticId = "unknown",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancelled = false;
    const cleanup = (): void => {
      if (timer) clearTimer(timer);
      signal?.removeEventListener("abort", abort);
    };
    const rejectCancelled = (err: Error): void => {
      if (settled) return;
      cancelled = true;
      settled = true;
      cleanup();
      reject(err);
    };
    const abort = (): void => rejectCancelled(cancelledError("MCP tool call was cancelled."));
    const timer = setTimer(() => rejectCancelled(new Error(message)), ms);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        if (cancelled) {
          debugLateResponse(`[Copilot Agent] Discarded late MCP tool response for ${syntheticId}.`);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (cancelled) {
          debugLateResponse(`[Copilot Agent] Discarded late MCP tool error for ${syntheticId}: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}

function debugLateResponse(message: string): void {
  // eslint-disable-next-line no-console -- documented redaction seam (Phase 6 late MCP cancellation response)
  console.debug(redactSensitive(message));
}
