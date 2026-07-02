import type { PermissionDecider } from "../domain/PermissionDecision";
import type { PermissionRequest } from "../domain/types";
import { isAuthError as isAuthErrorLocal } from "../auth/isAuthError";
import {
  decideSafety,
  type SafetyConfig,
  type SafetyDecisionResult,
  type SafetyPolicyInput,
  type SafetyState,
} from "../domain/SafetyPolicy";
import { isVaultWriteToolName } from "../tools/WriteTools";
import { formatMcpApprovalText } from "./approvalText";
import { redactSensitive } from "../mcp/redactSensitive";
import {
  parseSyntheticId,
  type McpToolSourceMetadata,
} from "../mcp/McpToolIdentity";
import type { McpToolRegistrySnapshot } from "../mcp/McpToolRegistry";
import { normalizeMcpResult } from "../mcp/normalizeMcpResult";

export interface AssistantMessage {
  /** Rendered text from the model. May be empty if the turn produced only tool errors. */
  content: string;
  /** Tool calls that ran or were rejected during this turn. */
  toolCalls: AssistantToolCall[];
}

export interface AssistantToolCall {
  id: string;
  /** SDK request `kind` (`shell`, `mcp`, `custom-tool`, etc.) when known. */
  kind: string;
  name?: string;
  /**
   * Phase 5: source classification for the UI tool-call block.
   *   - `custom`  — registered by us (the read tools)
   *   - `mcp`     — provided by an MCP server (Phase 8)
   *   - `builtin` — bundled with the CLI runtime (shell, web_fetch, …)
   */
  source?: "custom" | "mcp" | "builtin";
  outcome: "denied" | "approved" | "completed" | "errored" | "cancelled" | "pending_approval";
  detail?: string;
  /** Truncated JSON of the tool arguments for display. */
  argsPreview?: string;
  /** Tool result content (when completed). */
  resultContent?: string;
  /**
   * Phase 6: when `outcome === "pending_approval"`, populated with the
   * data needed by the UI approval prompt. Cleared once the user makes
   * a choice. Always undefined for non-pending entries.
   */
  approval?: {
    /** Human-readable summary line (e.g. "Edit inbox/today.md"). */
    summary: string;
    /** Long-form prompt body (e.g. full shell command, write diff). */
    detail?: string;
    /** Whether the prompt should offer an "Approve for Session" button. */
    canOfferSession: boolean;
  };
}

export interface AgentSessionOptions {
  /** Resolved absolute path to the Copilot CLI single-executable binary. */
  cliPath: string;
  /**
   * GitHub token (gho_/ghp_). Phase 3: optional — when omitted, init() will
   * reject until setToken() is called by the AuthController. This lets us
   * construct the agent at plugin load time and wire the token in once
   * the user has authenticated.
   */
  gitHubToken?: string | null;
  /** COPILOT_HOME for the runtime (we point it at the plugin dir). */
  baseDirectory: string;
  /** Universal-approval-gate decider. Phase 2 = denyAll. Used as a fallback when `safety` is not provided. */
  decider: PermissionDecider;
  /**
   * Phase 6: when present, replaces `decider` as the policy source.
   * Each `handlePermission` call routes through `decideSafety(input,
   * config, state)`; `require-approval` outcomes block on
   * `onApprovalNeeded` (which the UI fulfils via `resolveApproval`).
   * Leave undefined to retain Phase 2's legacy `decider` path.
   */
  safety?: {
    /** Live policy configuration; read on every decision so settings updates apply immediately. */
    config: () => SafetyConfig;
    /** In-memory session-grants store. */
    state: SafetyState;
    /**
     * Optional: convert an SDK permission request into a vault-relative
     * path (when the request targets a vault write tool). The session
     * uses this to feed `SafetyPolicyInput.vaultRelativePath` to the
     * decision function. Returning undefined means "not a vault path".
     */
    extractVaultPath?: (request: SdkPermissionRequest) => string | undefined;
    /**
     * v0.5 Phase 2: synchronous current MCP identity accessor. It must
     * consult live manager state at decision time; removed, disabled,
     * disconnected, or crashlooping servers return null.
     */
    getMcpToolSourceMetadata?: (
      request: SdkPermissionRequest,
    ) => McpToolSourceMetadata | null;
  };
  /** Optional: skip listModels and force a specific model id. */
  preferredModel?: string;
  /**
   * v0.4 Phase 2: optional shared `ModelCatalog`. When provided and
   * in `ready` state, `pickModel()` reuses the cached `chatModels`
   * via `resolveHeuristicModelId()` instead of issuing another
   * `client.listModels()` round-trip. When absent, `loading`,
   * `empty`, or `error`, the v0.3 fallback path runs unchanged
   * (fresh `listModels()` + heuristic). Phase 5 introduces deferred
   * `createSession()` for the catalog-degraded recovery UX; Phases
   * 1–4 do not change session-creation timing.
   */
  catalog?: import("./ModelCatalog").ModelCatalog;
  /** Optional: forwarded to the SDK CopilotClient as logLevel. */
  logLevel?: "none" | "error" | "warning" | "info" | "debug" | "all";
  /**
   * Called when init() or sendMessage() fails with what looks like an
   * auth error. Lets AuthController flip to its `error` state so the UI
   * prompts the user to reconnect, instead of silently retrying.
   */
  onAuthError?: (err: unknown) => void;
  /**
   * Phase 5: custom tools to register with each session (read_file,
   * view, search_content). Each tool's handler runs in-process inside
   * the renderer; see `src/tools/ReadTools.ts`. Empty / undefined =
   * no custom tools (legacy Phase 1–4 behaviour).
   */
  tools?: SdkTool[];
  /** MCP custom-tool snapshot producer. Read only at SDK session boundaries. */
  mcpTools?: () => readonly SdkTool[] | McpToolRegistrySnapshot | undefined;
  /**
   * Phase 9 (MCP readiness gate): optional promise-returning callback
   * awaited once inside `init()` before `client.createSession()` fires.
   * Lets the plugin block session creation until enabled MCP servers
   * have reached a terminal runtime status (connected / error / etc)
   * so their tools are present in the `toolsForSession()` snapshot.
   *
   * Without this gate, on plugin reload the SDK session is created with
   * an empty MCP tool list because stdio child processes are still
   * spawning; the tool list is frozen for the lifetime of that session
   * (there is no `updateTools()` API in the SDK). The user then can't
   * call any MCP tool from that conversation until they start a new
   * one, which is a surprising UX regression.
   *
   * The callback should never reject — failures inside it are swallowed
   * so a broken gate can't wedge session init. It should also enforce
   * its own timeout: `init()` awaits it verbatim.
   */
  mcpReadinessGate?: () => Promise<void>;
  /**
   * Phase 2 (MCP Readiness UX): callback invoked at the boundaries of
   * every `awaitMcpReadinessGate()` cycle. Fires `start` immediately
   * before awaiting the gate and `resolved` after the gate promise
   * fulfills (both the "all connected" and the "timed out" outcomes
   * surface as `resolved` — `McpManager.waitUntilEnabledReady` already
   * encapsulates the ceiling and resolves silently in either case).
   *
   * The callback should never reject — failures inside it are logged
   * and swallowed so a broken listener can't wedge session init.
   */
  onReadinessGateEvent?: (evt: "start" | "resolved") => void;
  /**
   * Phase 2 (Chat UX + Vault Tools): callback invoked on the FIRST
   * `sendMessage`/`sendMessageStreaming` of each SDK session (i.e. on
   * init() and on each `resetConversation()`). Its return value is
   * prepended to the user's text with a documented marker so the model
   * receives vault context before responding. Lazy so settings changes
   * apply on the next reset without restarting the runtime. Return
   * null/empty to skip prepending.
   */
  preamble?: () => string | null;
}

/**
 * Minimal structural shape of the SDK `Tool` returned by
 * `defineTool()`. We don't import the SDK type here so the file
 * stays unit-testable without the runtime SDK install.
 */
export interface SdkTool {
  name: string;
  description?: string;
  parameters?: unknown;
  handler?: (args: unknown, invocation: unknown) => Promise<unknown> | unknown;
  overridesBuiltInTool?: boolean;
  skipPermission?: boolean;
}

export interface AssistantToolCallExtras {
  /** Truncated string representation of the tool arguments. */
  argsPreview?: string;
  /** When the tool ran successfully, the result text the model saw. */
  resultContent?: string;
}

/**
 * Normalised stream event surface consumed by the chat view. Insulates
 * the UI from the raw SDK event shape so Phase 5 can extend this (e.g.
 * with `tool_call`) without touching the renderer plumbing.
 */
export type StreamEvent =
  | { type: "delta"; text: string }
  | {
      type: "tool_call_start";
      toolCall: AssistantToolCall;
    }
  | {
      type: "tool_call_complete";
      id: string;
      outcome: "completed" | "errored" | "denied" | "cancelled";
      content?: string;
      errorMessage?: string;
    }
  | {
      // Phase 6: emitted by handlePermission when SafetyPolicy returns
      // `require-approval`. Consumed by ChatView to upsert a pending
      // tool-call block (containing the ApprovalPrompt UI). When the
      // user clicks Approve/Reject, ChatView calls
      // `agent.resolveApproval(toolCallId, choice)`, which resolves a
      // deferred in pendingApprovals.
      type: "approval_prompt";
      toolCall: AssistantToolCall;
    }
  | {
      // Phase 6: emitted from `resolveApproval` so the UI flips the
      // tool-call block from pending → approved (or denied) before the
      // SDK's own tool.execution_* events arrive.
      type: "approval_resolved";
      id: string;
      choice: ApprovalChoice;
    }
  | { type: "complete"; content: string; toolCalls: AssistantToolCall[] };

/** User's response to a pending approval prompt. */
export type ApprovalChoice =
  | { kind: "approve-once" }
  | { kind: "approve-for-session" }
  | { kind: "reject"; reason?: string }
  | { kind: "cancelled"; reason?: string };

type PendingApprovalDeferred = {
  resolve: (choice: ApprovalChoice) => void;
  promise: Promise<ApprovalChoice>;
};

type PendingMcpApproval = {
  deferred: PendingApprovalDeferred;
  toolName?: string;
  trustEpoch?: string;
};

/**
 * Public adapter surface. The rest of the codebase consumes this — the
 * concrete CopilotAgentSession encapsulates all SDK interactions.
 */
export interface AgentSession {
  /** Idempotent. Resolves once the SDK is up and a session is created. */
  init(): Promise<void>;
  /** Send a user message and await a single assistant turn. Non-streaming. */
  sendMessage(text: string): Promise<AssistantMessage>;
  /**
   * Streaming variant. Emits `delta` events as the SDK forwards
   * `assistant.message_delta` chunks, then a single terminal `complete`
   * event carrying the consolidated text and tool-call summary.
   *
   * Cancellation: call `cancelCurrent()` to abort. The iterator stops
   * cleanly; whatever partial text was already yielded is left to the
   * caller to render (Phase 4 freezes it as `interrupted`).
   */
  sendMessageStreaming(text: string): AsyncIterable<StreamEvent>;
  /**
   * Abort an in-flight `sendMessage`/`sendMessageStreaming`. Safe to
   * call when nothing is in flight (no-op). The SDK session itself
   * remains usable for the next turn.
   */
  cancelCurrent(): Promise<void>;
  /** Reset the SDK session so model context is forgotten. */
  resetConversation(): Promise<void>;
  /**
   * Swap the GitHub token. Stops the running SDK runtime so the next
   * init() picks up the new token. Pass `null` to disconnect (init()
   * will reject until a non-null token is set).
   *
   * IMPORTANT: this is non-terminal — the AgentSession can be reused
   * after setToken(). Use `dispose()` only at plugin unload.
   */
  setToken(token: string | null): Promise<void>;
  /**
   * Force a fresh init() cycle and return the resolved model id. Used
   * by AuthController to validate a new or persisted token.
   */
  reconnect(): Promise<string | undefined>;
  /** Tear down the SDK session and stop the runtime. Idempotent.
   *  TERMINAL — after dispose() the AgentSession cannot be reused. */
  dispose(): Promise<void>;
  /** Currently selected model id, or undefined if init hasn't run. */
  getModel(): string | undefined;
  /**
   * v0.4 FR-005: swap the active model on the underlying SDK session
   * via `session.setModel()`, preserving conversation history. Cancels
   * any in-flight stream and pending approvals first so the swap takes
   * effect cleanly on the next message.
   *
   * Behavior:
   *  - If `newModelId === getModel()`: no-op (identity).
   *  - If the SDK session has not been created yet (no init run): just
   *    updates the preferred-model override so the next init/reset
   *    selects `newModelId`. No network call.
   *  - Otherwise: cancels pending approvals with reason "model-swap",
   *    aborts any in-flight turn, then awaits `session.setModel()`.
   *    `selectedModel` is updated ONLY after the SDK call resolves so a
   *    rejection leaves state unchanged.
   *
   * Throws if disposed or if the SDK does not support `setModel`.
   */
  swapModel(newModelId: string): Promise<void>;
  /**
   * Phase 2 (MCP Readiness UX): synchronous read of readiness-gate
   * state. Returns `true` while an `awaitMcpReadinessGate()` cycle
   * is in flight, `false` otherwise. Used by `ChatView.bindActiveRuntime`
   * to seed the readiness pill on late binds (planning-docs review S2).
   */
  isReadinessGateWaiting(): boolean;
  /**
   * Phase 3 (MCP Readiness UX): apply the current MCP + custom tool
   * snapshot to the live SDK session. Called by `main.ts` when
   * `McpStatusWatcher.onTransition` fires (a server crossed
   * connecting → connected or reconnecting → connected, or the
   * reverse). Behavior:
   *   - If `this.session` is not yet created (pre-init), no-op.
   *   - If the SDK exposes a live update primitive
   *     (`hasLiveToolUpdate()`), rebuild the tool list via
   *     `toolsForSession()` and call the primitive.
   *   - If the primitive is absent (SDK 1.0.0 fallback), record the
   *     no-op once and return (FR-011 strict no-op).
   *   - If a streaming turn is in flight (`isStreaming` true), latch
   *     `pendingToolUpdate` and drain on stream completion — the
   *     drain rebuilds the list from the live snapshot so the
   *     always-latest set applies (last-write-wins).
   */
  applyToolListChange(): Promise<void>;
  /**
   * Phase 3 (MCP Readiness UX): does this session expose the live
   * tool-update primitive? Consumed by `main.ts` to gate the "tools
   * now available" Notice — with SDK 1.0.0 the primitive is absent
   * and toasting would mislead users (tools require reload).
   */
  hasLiveToolUpdate(): boolean;
  /**
   * Phase 6: resolve a pending approval prompt with the user's choice.
   * Called by the chat view when the user clicks an approval button.
   * No-op if no approval is pending for this tool-call id (e.g. the
   * prompt was already auto-rejected during cleanup).
   */
  resolveApproval(toolCallId: string, choice: ApprovalChoice): void;
  /**
   * v0.4: does this session currently have any tool-approval prompts
   * awaiting user response? Consumed by the model-picker confirmation
   * copy so the user knows pending approvals will be cancelled by
   * `swapModel()` if they confirm the switch.
   */
  hasPendingApprovals(): boolean;
  cancelPendingMcpApprovalsForServer(serverId: string, reason?: string): void;
  cancelMcpCallsForServer(serverId: string, reason?: string): void;
  /**
   * v0.4 Phase 5 (S1 — deferred-init contract): true iff `init()`
   * resolved successfully but `createSession()` was NOT issued because
   * the wired `ModelCatalog` was in `empty`/`error` and no
   * `preferredModel` override was usable. In this state:
   *   - `sendMessage`/`sendMessageStreaming` reject with a "pick a
   *     model" error (UI consumes via `canSend()`).
   *   - `swapModel(newId)` will set the preferred override AND
   *     immediately attempt session creation if a client is alive.
   *   - The session subscribes to the catalog and auto-recovers when
   *     it transitions to `ready` (catalog retry, token rotation, or
   *     the user picks an id).
   * Returns false in the healthy path (createSession ran) and after
   * deferred recovery succeeds.
   */
  hasDeferredSession(): boolean;
}

const SDK_IDLE_TIMEOUT_MS = 180_000;
// SDK ceiling: passed as the second arg to session.sendAndWait so the
// SDK's own (wall-clock, non-idle-aware) timeout doesn't fire before
// our idle watchdog. Set high; our bumpIdleTimer is the actual guard.
const SDK_HARD_CEILING_MS = 30 * 60_000;
const STOP_TIMEOUT_MS = 5_000;

/**
 * v0.4 (model-picker) Phase 2: pure heuristic resolver extracted from
 * the historical `AgentSession.pickModel()` body. Used both by the
 * legacy `pickModel()` adapter (when the catalog is non-ready or
 * unavailable) and by `ConversationManager.createInternal()` in
 * Phase 3 to resolve a default modelId at conversation creation.
 *
 * Selection order (preserved verbatim from v0.3 to keep
 * AgentSession's existing happy-path test green):
 *   1. enabled `gpt-4.1`
 *   2. enabled `gpt-4o`
 *   3. first enabled id starting with `gpt-`
 *   4. first enabled record (or first record overall if none enabled)
 *
 * "Enabled" matches the v0.3 rule (no `policy` field, or `policy.state`
 * is `"enabled"` or `undefined`). When the enabled subset is empty we
 * fall back to the full input — same as v0.3 — so accounts whose
 * records carry exotic policy values still resolve.
 *
 * Returns `null` only when the input list is itself empty (or every
 * record lacks a string `id`). Callers translate that into a
 * user-visible failure (Spec FR-018, Phase 5 inline-error UX).
 */
export function resolveHeuristicModelId(
  models: SdkModelInfo[],
): string | null {
  if (!Array.isArray(models) || models.length === 0) return null;
  const enabled = models.filter(
    (m) =>
      !m.policy ||
      m.policy.state === "enabled" ||
      m.policy.state === undefined,
  );
  const pool = enabled.length > 0 ? enabled : models;
  if (pool.length === 0) return null;
  const chosen =
    pool.find((m) => m.id === "gpt-4.1") ??
    pool.find((m) => m.id === "gpt-4o") ??
    pool.find((m) => (m.id ?? "").startsWith("gpt-")) ??
    pool[0];
  const id = chosen.id ?? pool[0].id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export class CopilotAgentSession implements AgentSession {
  private initPromise: Promise<void> | null = null;
  private client: SdkClient | null = null;
  private session: SdkSession | null = null;
  private selectedModel: string | undefined;
  /**
   * Phase 2 (MCP Readiness UX): `true` while `awaitMcpReadinessGate()`
   * is in flight. Exposed via `isReadinessGateWaiting()` so ChatView
   * can seed the readiness pill on late binds (planning-docs review S2).
   */
  private readinessGateWaiting = false;
  /**
   * Phase 3 (MCP Readiness UX): `true` while a
   * `sendMessageStreaming` iterator is producing events. Read by
   * `applyToolListChange` to decide between apply-now and
   * latch-and-drain. Flipped in the streaming generator (`try` at
   * top, `finally` at bottom).
   */
  private isStreamingFlag = false;
  /**
   * Phase 3 (MCP Readiness UX): last-write-wins latch. Set when
   * `applyToolListChange` is invoked mid-stream; drained in the
   * streaming finally block. Boolean — the tool list is always
   * rebuilt from the current `mcpTools()` snapshot at drain time
   * so no payload queue is needed (planning-docs S1 semantics).
   */
  private pendingToolUpdate = false;
  /**
   * Phase 3 (MCP Readiness UX): guard so the SDK-1.0.0 no-op
   * fallback is logged at most once per session — otherwise a
   * flapping server could spam the console.
   */
  private loggedNoOpFallback = false;
  /**
   * v0.4 FR-005: per-instance override of `opts.preferredModel`. Set by
   * `swapModel()` (mid-life model change) so that subsequent
   * init/reset cycles converge on the user's most-recent choice rather
   * than reverting to the construction-time `preferredModel`.
   * `undefined` means "use opts.preferredModel".
   */
  private preferredModelOverride: string | undefined;
  /** Set once `dispose()` runs. Terminal — blocks all future init(). */
  private disposed = false;
  /**
   * Monotonic counter incremented whenever the runtime is torn down
   * (`stopRuntime`, `dispose`). `doInit` captures this value at the
   * start of its run and bails (cleaning up any client it built) if it
   * sees the counter has advanced at any `await` boundary. This closes
   * a Windows-cold-start race where `setToken()` rotates the token,
   * `stopRuntime` times out waiting for the slow in-flight init, nulls
   * `this.client`/`this.session`, and then the in-flight init resumes
   * and re-assigns those fields with a client built from the OLD token
   * — leaking the subprocess and producing a stale-token session.
   */
  private initEpoch = 0;
  /**
   * Current OAuth token. Mutable so AuthController can rotate it via
   * `setToken()` without rebuilding the AgentSession instance. `null`
   * means "not connected" — init() will reject.
   */
  private currentToken: string | null;
  private toolCallsThisTurn: AssistantToolCall[] = [];

  /**
   * Upsert by id into `toolCallsThisTurn`. Used by handlePermission to
   * avoid creating a duplicate entry when `tool.execution_start` already
   * fired for the same toolCallId before permissionRequested. Without
   * this, end-of-stream replay (`yield {type: "complete", toolCalls}`)
   * would surface the lingering pending_approval entry and regress the
   * UI from completed back to pending.
   */
  private upsertTurnToolCall(call: AssistantToolCall): void {
    const idx = this.toolCallsThisTurn.findIndex((c) => c.id === call.id);
    if (idx < 0) {
      this.toolCallsThisTurn.push(call);
      return;
    }
    this.toolCallsThisTurn[idx] = { ...this.toolCallsThisTurn[idx], ...call };
  }

  private readonly sdkLoader: () => Promise<SdkModule>;
  /**
   * Set during sendMessageStreaming. When non-null, handlePermission +
   * tool.execution_* handlers mirror their events to the live stream
   * consumer so the chat view can render tool-call blocks in real time.
   * Cleared on stream teardown so out-of-band events (a stray
   * post-stream tool completion) don't try to push into a dead queue.
   */
  private currentStreamPush:
    | ((ev: StreamEvent) => void)
    | null = null;
  /**
   * Set during sendMessageStreaming. Resets the idle timeout when called.
   * handlePermission calls it on permission requests so that long-running
   * approval flows don't trip the idle watchdog.
   */
  private bumpIdleTimer: (() => void) | null = null;
  /**
   * Set of tool names we registered as custom tools, used to classify
   * tool sources (`custom` vs `builtin`/`mcp`) in the chat UI.
   */
  private readonly customToolNames: Set<string>;
  /**
   * Defensive copy of `opts.tools` so external mutation can't surprise
   * us between the init() and resetConversation() createSession calls.
   */
  private readonly toolsList: SdkTool[] | undefined;
  /**
   * Phase 6: in-flight approval prompts keyed by tool-call id. Resolved
   * by `resolveApproval`; rejected en masse by `cancelAllPendingApprovals`
   * on cancel/reset/dispose/setToken so a dangling deferred never
   * leaves the SDK awaiting a response. The value type is a deferred
   * holding the user's choice (never rejects the underlying promise —
   * cancellation resolves with `{ kind: "reject", reason: ... }` so
   * the SDK contract returns a clean PermissionRequestResult).
   */
  private readonly pendingApprovals = new Map<
    string,
    PendingApprovalDeferred
  >();

  /**
   * In-flight MCP approval prompts indexed by exact stable server id.
   * Resolved approval cache entries are keyed differently, so server
   * lifecycle cancellation must not rely on scanning that cache.
   */
  private readonly pendingMcpApprovalsByServer = new Map<
    string,
    Map<string, PendingMcpApproval>
  >();
  private readonly activeMcpCallsByServer = new Map<string, Set<string>>();
  private readonly lifecycleCancelledMcpCallIds = new Set<string>();

  /**
   * Memo of approval choices already resolved for a given toolCallId in
   * this session. The SDK can re-emit `permissionRequested` for an already-
   * approved/rejected toolCall (e.g., on agent-loop replay or follow-up
   * iterations). When that happens we must NOT prompt the user again —
   * we'd flip the UI back to pending_approval after the call has already
   * completed, and the new Deferred would never resolve. Instead, we
   * short-circuit with the prior choice.
   */
  private readonly resolvedApprovals = new Map<
    string,
    ApprovalChoice & { mcpCacheKey?: string }
  >();

  /**
   * Phase 2 (Chat UX + Vault Tools): true until the first
   * `sendMessage`/`sendMessageStreaming` of the current SDK session has
   * been issued. Reset to true on every `createSession` (init + reset).
   * When true, `wrapWithPreamble` prepends the vault-aware preamble to
   * the outgoing text. Flipped to false after the prepended text has
   * been handed to `session.sendAndWait`.
   */
  private firstSendOfSession = true;
  /**
   * Diagnostics hook: records the text actually sent to the SDK on the
   * most recent first-send and on the most recent subsequent send. Used
   * by unit tests to verify (a) preamble was prepended on first send,
   * (b) second send is untouched. Not part of the public AgentSession
   * surface — read via `preambleProbe()`.
   */
  private lastFirstSendText: string | null = null;
  private lastFollowupSendText: string | null = null;

  /**
   * v0.4 Phase 5 (S1): true iff `doInit()` finished without calling
   * `createSession()` because the wired `ModelCatalog` is non-ready
   * and no usable `preferredModel` override exists. While this flag
   * is set the SDK runtime is live (`client !== null`) but `session`
   * is null. Cleared by `tryRecoverDeferred()` on successful catalog
   * `ready` transition or by an explicit `swapModel(newId)`. Also
   * cleared on `stopRuntime()` / `dispose()` so a fresh `init()`
   * goes through the standard non-deferred path.
   */
  private deferredSession = false;
  /** Unsubscribe handle for the catalog listener (constructor wired). */
  private unsubCatalog: (() => void) | null = null;

  constructor(
    private readonly opts: AgentSessionOptions,
    sdkLoader?: () => Promise<SdkModule>,
  ) {
    this.sdkLoader = sdkLoader ?? defaultSdkLoader;
    this.currentToken = opts.gitHubToken ?? null;
    this.toolsList = opts.tools ? [...opts.tools] : undefined;
    this.customToolNames = new Set(
      (this.toolsList ?? []).map((t) => t.name).filter(Boolean) as string[],
    );
    // v0.4 Phase 5 (S1): subscribe to the catalog so a `ready`
    // transition (catalog retry, token rotation, deferred lazy
    // refresh) drives auto-recovery of a deferred session. We do
    // NOT trigger a refresh here — main.ts owns refresh sequencing.
    if (opts.catalog) {
      this.unsubCatalog = opts.catalog.subscribe((state) => {
        if (
          state.kind === "ready" &&
          this.deferredSession &&
          !this.disposed
        ) {
          void this.tryRecoverDeferred().catch((e) =>
            console.warn(
              "[AgentSession] tryRecoverDeferred from catalog notify failed",
              e,
            ),
          );
        }
      });
    }
  }

  getModel(): string | undefined {
    return this.selectedModel;
  }

  hasDeferredSession(): boolean {
    return this.deferredSession;
  }

  init(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("AgentSession disposed"));
    }
    if (!this.currentToken) {
      return Promise.reject(
        new Error("AgentSession has no GitHub token. Connect first."),
      );
    }
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err) => {
        // Reset so a future caller can retry with a fresh attempt.
        this.initPromise = null;
        // Surface auth failures to AuthController so it can flip its
        // state to `error` instead of leaving the UI on "Connecting…".
        if (this.opts.onAuthError && isAuthErrorLocal(err)) {
          try {
            this.opts.onAuthError(err);
          } catch (e) {
            console.warn("[AgentSession] onAuthError handler threw", e);
          }
        }
        throw err;
      });
    }
    return this.initPromise;
  }

  async sendMessage(text: string): Promise<AssistantMessage> {
    try {
      await this.init();
    } catch (err) {
      // init() already invoked onAuthError if applicable; rethrow so the
      // chat view can show the failure to the user.
      throw err;
    }
    if (this.deferredSession) {
      throw new Error(
        "Model catalog unavailable — pick a model in the chat header to continue.",
      );
    }
    if (!this.session) {
      throw new Error("AgentSession.session missing after init");
    }
    this.toolCallsThisTurn = [];
    this.activeMcpCallsByServer.clear();
    this.lifecycleCancelledMcpCallIds.clear();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bumpIdleTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        try {
          this.session?.abort?.();
        } catch (e) {
          console.warn("[AgentSession] abort on timeout failed", e);
        }
      }, SDK_IDLE_TIMEOUT_MS);
    };
    bumpIdleTimer();
    // sendMessage (non-streaming) has no intermediate activity hooks
    // so the idle timer here behaves as a wall-clock budget. The
    // streaming path resets it on each delta / tool event.
    try {
      const outgoing = this.wrapWithPreamble(text);
      const resp = await this.session.sendAndWait(outgoing, SDK_HARD_CEILING_MS);
      if (timedOut) {
        throw new Error(
          `Model went idle for over ${SDK_IDLE_TIMEOUT_MS / 1000}s`,
        );
      }
      return {
        content: extractText(resp) ?? "",
        toolCalls: this.toolCallsThisTurn,
      };
    } catch (err) {
      if (this.opts.onAuthError && isAuthErrorLocal(err)) {
        try {
          this.opts.onAuthError(err);
        } catch (e) {
          console.warn("[AgentSession] onAuthError handler threw", e);
        }
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Streaming variant of {@link sendMessage}. Implementation notes:
   *
   * - Subscribes to `assistant.message_delta` *before* sending so we never
   *   race the SDK and drop the first chunk.
   * - `session.sendAndWait()` resolves once the SDK emits `session.idle`,
   *   at which point we yield a terminal `complete` event containing the
   *   final consolidated content (which may differ slightly from the
   *   concatenated deltas — e.g. when the model produces tool calls
   *   between text segments).
   * - On `cancelCurrent()` the underlying promise typically rejects; we
   *   translate that into a terminal `complete` with whatever text the
   *   chat layer already accumulated and let the chat layer freeze the
   *   message as `interrupted`.
   * - On any non-cancel error we re-throw so the chat layer can render
   *   the failure.
   */
  async *sendMessageStreaming(text: string): AsyncIterable<StreamEvent> {
    try {
      await this.init();
    } catch (err) {
      throw err;
    }
    if (this.deferredSession) {
      throw new Error(
        "Model catalog unavailable — pick a model in the chat header to continue.",
      );
    }
    if (!this.session) {
      throw new Error("AgentSession.session missing after init");
    }
    // Phase 3 (MCP Readiness UX): announce streaming so
    // applyToolListChange defers to the drain. Cleared in the
    // outermost finally.
    this.isStreamingFlag = true;
    const session = this.session;
    this.toolCallsThisTurn = [];
    this.activeMcpCallsByServer.clear();
    this.lifecycleCancelledMcpCallIds.clear();

    const queue: StreamEvent[] = [];
    let resolveWait: (() => void) | null = null;
    /**
     * Set to false once we yield a terminal `complete` or throw.
     * Subsequent delta callbacks are dropped so a stray event from the
     * SDK after settlement can't corrupt state.
     */
    let acceptingDeltas = true;
    const push = (ev: StreamEvent): void => {
      if (!acceptingDeltas && ev.type === "delta") return;
      queue.push(ev);
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r();
      }
    };
    // Expose to handlePermission + tool-event handlers so denied
    // built-ins and completed custom-tool calls reach the chat UI
    // live. Cleared in finally so post-stream events can't push into
    // a dead queue.
    this.currentStreamPush = push;

    // Subscribe *before* sending so the first delta isn't lost.
    let unsubDelta: (() => void) | undefined;
    let unsubToolStart: (() => void) | undefined;
    let unsubToolComplete: (() => void) | undefined;
    if (typeof session.on === "function") {
      try {
        unsubDelta = session.on("assistant.message_delta", (event) => {
          const delta = event?.data?.deltaContent;
          if (typeof delta === "string" && delta.length > 0) {
            bumpIdleTimer();
            push({ type: "delta", text: delta });
          }
        });
      } catch (e) {
        console.warn("[AgentSession] session.on subscribe failed", e);
      }
      try {
        unsubToolStart = session.on("tool.execution_start", (event) => {
          const d = event?.data;
          if (!d || typeof d.toolCallId !== "string") return;
          bumpIdleTimer();
          const source = classifyToolSource(
            d.mcpServerName ? "mcp" : undefined,
            d.toolName,
            this.customToolNames,
          );
          // Build / refresh the assistant tool-call record. If
          // handlePermission already pushed an entry (approved
          // permission flow), update it; otherwise (skipPermission
          // tools) create a fresh one.
          let existing = this.toolCallsThisTurn.find(
            (c) => c.id === d.toolCallId,
          );
          const argsPreview =
            source === "mcp"
              ? stringifyMcpArgsForPreview(d.arguments)
              : stringifyArgsForPreview(d.arguments);
          if (existing) {
            existing.source = source;
            existing.argsPreview = argsPreview;
            if (!existing.name) existing.name = d.toolName;
          } else {
            existing = {
              id: d.toolCallId,
              kind: source === "mcp" ? "mcp" : "tool",
              name: d.toolName,
              source,
              outcome: "approved",
              argsPreview,
            };
            this.toolCallsThisTurn.push(existing);
          }
          if (source === "mcp") {
            const parsed = parseSyntheticId(d.toolName);
            if (parsed) this.registerActiveMcpCall(parsed.serverId, d.toolCallId);
          }
          push({ type: "tool_call_start", toolCall: { ...existing } });
        });
      } catch (e) {
        console.warn("[AgentSession] session.on tool.start subscribe failed", e);
      }
      try {
        unsubToolComplete = session.on("tool.execution_complete", (event) => {
          const d = event?.data;
          if (!d || typeof d.toolCallId !== "string") return;
          if (this.lifecycleCancelledMcpCallIds.has(d.toolCallId)) return;
          bumpIdleTimer();
          const existing = this.toolCallsThisTurn.find(
            (c) => c.id === d.toolCallId,
          );
          const errorText = typeof d.error?.message === "string" ? d.error.message : "";
          let outcome: "completed" | "errored" | "cancelled" = d.success
            ? "completed"
            : isAbortError(d.error) || /cancel/i.test(errorText)
              ? "cancelled"
              : "errored";
          let resultContent = sanitizeMcpMaybe(
            existing?.source,
            d.result?.detailedContent ?? d.result?.content ?? undefined,
          );
          let errorMessage = sanitizeMcpMaybe(existing?.source, d.error?.message);
          // Phase 8: `McpToolBridge` now returns MCP tool-execution errors as
          // tool-result content (industry pattern from bastani/atomic, kimchi,
          // inkeep) so the message reaches chat even when the SDK's error
          // pipeline drops it. But that means the SDK marks the call
          // `success: true`, which paints a green "completed" pill on a call
          // that actually failed. Detect the sentinel prefix here and
          // re-classify: outcome → errored, content → detail, status pill
          // becomes red, body renders the "Error" section. Only applies when
          // source is mcp so we don't misclassify legitimate results that
          // happen to start with "Error:".
          if (
            existing?.source === "mcp" &&
            outcome === "completed" &&
            typeof resultContent === "string" &&
            (resultContent.startsWith("Error: MCP tool reported error:") ||
              resultContent.startsWith("Error: MCP JSON-RPC error:"))
          ) {
            outcome = "errored";
            errorMessage = resultContent;
            resultContent = undefined;
          }
          if (existing?.source === "mcp") this.unregisterActiveMcpCall(d.toolCallId);
          if (existing) {
            existing.outcome = outcome;
            // Clear approval metadata once the call has executed; the
            // UI gates the prompt on `outcome === "pending_approval"`,
            // but a stale approval object on a completed entry is
            // confusing if anything else inspects it.
            existing.approval = undefined;
            if (resultContent !== undefined)
              existing.resultContent = resultContent;
            if (errorMessage !== undefined) existing.detail = errorMessage;
          }
          push({
            type: "tool_call_complete",
            id: d.toolCallId,
            outcome,
            content: resultContent,
            errorMessage,
          });
        });
      } catch (e) {
        console.warn(
          "[AgentSession] session.on tool.complete subscribe failed",
          e,
        );
      }
    }
    const cleanupSubscription = (): void => {
      for (const u of [unsubDelta, unsubToolStart, unsubToolComplete]) {
        if (!u) continue;
        try {
          u();
        } catch (e) {
          console.warn("[AgentSession] unsubscribe failed", e);
        }
      }
      unsubDelta = undefined;
      unsubToolStart = undefined;
      unsubToolComplete = undefined;
    };

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bumpIdleTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        this.cancelCurrent().catch((e) =>
          console.warn("[AgentSession] abort on timeout failed", e),
        );
      }, SDK_IDLE_TIMEOUT_MS);
    };
    bumpIdleTimer();
    // Expose to handlePermission so the idle timer also resets when
    // the SDK asks for permission (an explicit sign of model activity).
    this.bumpIdleTimer = bumpIdleTimer;

    let done = false;
    let settled = false; // sendAndWait has resolved or rejected
    let finalContent = "";
    let failure: unknown = null;

    const wakeup = (): void => {
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r();
      }
    };

    // Kick off the turn but DON'T await — we need to interleave with
    // the queue draining loop below.
    const outgoing = this.wrapWithPreamble(text);
    session
      .sendAndWait(outgoing, SDK_HARD_CEILING_MS)
      .then(
        (resp) => {
          settled = true;
          finalContent = extractText(resp) ?? "";
          done = true;
          wakeup();
        },
        (err) => {
          settled = true;
          // Check timeout BEFORE abort detection: a timeout-triggered
          // abort error must surface as a timeout failure, not be
          // silently swallowed as a user cancellation.
          if (timedOut) {
            failure = new Error(
              `Model went idle for over ${SDK_IDLE_TIMEOUT_MS / 1000}s`,
            );
          } else if (isAbortError(err)) {
            // User-initiated cancel (or any other abort path) — end
            // the stream cleanly, no failure.
          } else {
            failure = err;
          }
          done = true;
          wakeup();
        },
      );

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
      }
      // Drain any deltas that arrived after `done` flipped but before
      // we re-entered the loop.
      while (queue.length > 0) {
        yield queue.shift()!;
      }

      // Unsubscribe BEFORE yielding the terminal `complete`. This
      // guarantees no late delta can sneak into state after the
      // consumer has accepted the terminal event.
      acceptingDeltas = false;
      cleanupSubscription();

      if (failure) {
        if (this.opts.onAuthError && isAuthErrorLocal(failure)) {
          try {
            this.opts.onAuthError(failure);
          } catch (e) {
            console.warn("[AgentSession] onAuthError handler threw", e);
          }
        }
        throw failure;
      }

      yield {
        type: "complete",
        content: finalContent,
        toolCalls: this.toolCallsThisTurn,
      };
    } finally {
      if (timer) clearTimeout(timer);
      this.bumpIdleTimer = null;
      acceptingDeltas = false;
      cleanupSubscription();
      this.currentStreamPush = null;
      this.cancelAllPendingApprovals(
        "Stream ended before user approved this tool call.",
      );
      // If the consumer closed the iterator early (break, throw, view
      // teardown) the SDK turn may still be in flight. Abort it on the
      // captured `session` so it doesn't keep running in the background
      // and tie up the SDK channel for the next turn. We deliberately
      // use the captured `session` rather than `this.cancelCurrent()`
      // so a reset/reconnect that swapped `this.session` can't make us
      // abort a newer, unrelated turn.
      if (!settled && typeof session.abort === "function") {
        try {
          await Promise.resolve(session.abort());
        } catch (e) {
          console.warn("[AgentSession] early-close abort failed", e);
        }
      }
      // Phase 3 (MCP Readiness UX): stream complete. Clear the
      // streaming flag first (so applyToolListChange applies inline
      // rather than re-latching), then drain any pending update.
      this.isStreamingFlag = false;
      if (this.pendingToolUpdate) {
        this.pendingToolUpdate = false;
        // Fire-and-forget: don't block the generator's finally on
        // an SDK round-trip. Errors are logged by the method itself.
        void this.applyToolListChange().catch((e) => {
          console.warn("[AgentSession] drain applyToolListChange failed", e);
        });
      }
    }
  }

  async cancelCurrent(): Promise<void> {
    this.cancelAllPendingApprovals("User cancelled the turn.");
    const session = this.session;
    if (!session || typeof session.abort !== "function") return;
    try {
      await Promise.resolve(session.abort());
    } catch (e) {
      console.warn("[AgentSession] session.abort failed", e);
    }
  }

  /**
   * v0.4 FR-005: swap the active model on the underlying SDK session
   * without losing conversation history. See {@link AgentSession.swapModel}
   * for the contract.
   *
   * Implementation notes:
   *  - The "interrupt streaming placeholder BEFORE abort" detail
   *    (mirroring `ChatView.handleStop`) belongs to whichever caller
   *    owns the visible placeholder state (ChatView for live UI;
   *    ConversationRuntime.setModelId for orchestration). This method
   *    is UI-agnostic — it only owns SDK-level cancellation and the
   *    setModel call.
   *  - We update `selectedModel` AND `preferredModelOverride` only
   *    after `session.setModel()` resolves so that a rejection leaves
   *    the in-memory state matching the SDK's actual state. We also
   *    update the override so a subsequent reconnect/reset converges
   *    on the user's choice.
   */
  async swapModel(newModelId: string): Promise<void> {
    if (this.disposed) {
      throw new Error("AgentSession disposed");
    }
    if (typeof newModelId !== "string" || newModelId.length === 0) {
      throw new Error("swapModel: newModelId must be a non-empty string");
    }
    if (this.selectedModel === newModelId && !this.deferredSession) {
      // Identity no-op. Still record as the override so a future
      // reconnect/reset doesn't drift back to opts.preferredModel.
      this.preferredModelOverride = newModelId;
      return;
    }
    // v0.4 Phase 5 (S1): deferred recovery path. The runtime is alive
    // (client !== null) but no session was created because the catalog
    // was non-ready at init. The user just picked an id — record it
    // and create the session in-place. No need to cancel anything
    // (there is no session to be streaming or holding approvals).
    if (this.deferredSession && this.client) {
      this.preferredModelOverride = newModelId;
      this.selectedModel = newModelId;
      await this.tryRecoverDeferred(newModelId);
      return;
    }
    const session = this.session;
    if (!session) {
      // No SDK session yet (pre-init, post-stopRuntime, or disposed-
      // and-recreating). Just record the preferred-model override so
      // the next init/reset resolves to `newModelId`.
      this.preferredModelOverride = newModelId;
      this.selectedModel = newModelId;
      return;
    }
    if (typeof session.setModel !== "function") {
      throw new Error(
        "swapModel: underlying SDK session does not support setModel()",
      );
    }
    // Drain pending approvals and abort any in-flight turn first so
    // the SDK is quiescent when setModel() runs. cancelAllPendingApprovals
    // is idempotent; cancelCurrent() also calls it under the hood.
    this.cancelAllPendingApprovals("model-swap");
    try {
      await this.cancelCurrent();
    } catch (e) {
      console.warn("[AgentSession] swapModel cancelCurrent threw", e);
    }
    // Re-check session — cancelCurrent could race with stopRuntime if
    // a teardown is in flight. If the session is gone now, degrade to
    // the no-session path above.
    const live = this.session;
    if (!live) {
      this.preferredModelOverride = newModelId;
      this.selectedModel = newModelId;
      return;
    }
    await Promise.resolve(live.setModel!(newModelId));
    this.selectedModel = newModelId;
    this.preferredModelOverride = newModelId;
  }

  /**
   * Phase 2: prepend the vault-aware preamble to the FIRST send of the
   * current SDK session. Subsequent sends pass through unchanged. If no
   * preamble callback is configured or it returns null/empty, the text
   * is returned untouched.
   *
   * The marker line distinguishes the preamble block from the user's
   * actual prompt so future log analysis / tests can detect it.
   */
  private wrapWithPreamble(text: string): string {
    if (!this.firstSendOfSession) {
      this.lastFollowupSendText = text;
      return text;
    }
    this.firstSendOfSession = false;
    const preambleFn = this.opts.preamble;
    if (!preambleFn) {
      this.lastFirstSendText = text;
      return text;
    }
    let preamble: string | null;
    try {
      preamble = preambleFn();
    } catch (e) {
      console.warn("[AgentSession] preamble callback threw", e);
      this.lastFirstSendText = text;
      return text;
    }
    if (!preamble) {
      this.lastFirstSendText = text;
      return text;
    }
    const combined =
      preamble + "\n\n---\n\n## User request\n\n" + text;
    this.lastFirstSendText = combined;
    return combined;
  }

  private toolsForSession(): SdkTool[] | undefined {
    const base = this.toolsList ? [...this.toolsList] : [];
    let mcp: readonly SdkTool[] | McpToolRegistrySnapshot | undefined;
    try {
      mcp = this.opts.mcpTools?.();
    } catch (e) {
      console.warn("[AgentSession] MCP tools snapshot callback threw", e);
    }
    const mcpTools = Array.isArray(mcp) ? mcp : undefined;
    const combined = [...base, ...(mcpTools ?? [])];
    return combined.length > 0 ? combined : undefined;
  }

  /**
   * Phase 9 (MCP readiness gate): awaits the injected `mcpReadinessGate`
   * callback exactly once per SDK session creation. Swallows throws so a
   * broken gate can't wedge session init. Called at every createSession
   * site so `resetConversation` and deferred-catalog recovery also
   * benefit from the up-to-date MCP inventory.
   *
   * The gate itself owns its timeout (see `McpManager.waitUntilEnabledReady`).
   *
   * Phase 2 (MCP Readiness UX) additions:
   *  - Emits `start`/`resolved` via `opts.onReadinessGateEvent` so the
   *    UI can render/hide a "Preparing MCP tools…" pill.
   *  - Sets `readinessGateWaiting = true` for the duration of the wait
   *    so `isReadinessGateWaiting()` reflects reality synchronously
   *    (used by ChatView.bindActiveRuntime on conversation switch).
   */
  private async awaitMcpReadinessGate(): Promise<void> {
    const gate = this.opts.mcpReadinessGate;
    if (!gate) return;
    this.readinessGateWaiting = true;
    this.emitReadinessGateEvent("start");
    try {
      await gate();
    } catch (e) {
      console.warn("[AgentSession] mcpReadinessGate threw; proceeding without wait", e);
    } finally {
      this.readinessGateWaiting = false;
      this.emitReadinessGateEvent("resolved");
    }
  }

  private emitReadinessGateEvent(kind: "start" | "resolved"): void {
    const cb = this.opts.onReadinessGateEvent;
    if (!cb) return;
    try {
      cb(kind);
    } catch (e) {
      console.warn("[AgentSession] onReadinessGateEvent listener threw", e);
    }
  }

  /**
   * Returns `true` while an `awaitMcpReadinessGate()` cycle is in
   * flight. ChatView reads this synchronously on
   * `bindActiveRuntime()` to seed the readiness pill when activating
   * a conversation whose gate is already in progress — bus `start`
   * events would otherwise have been missed by late-bound observers.
   */
  isReadinessGateWaiting(): boolean {
    return this.readinessGateWaiting;
  }

  /**
   * Phase 3 (MCP Readiness UX): true iff the underlying SDK session
   * exposes the live tool-update primitive that will land in the
   * upstream SDK PR (Phase 4). Duck-typed against a well-known method
   * name so this file can build against the current SDK 1.0.0
   * unchanged. When Phase 5 pins the new SDK version, this helper
   * becomes the single flip point (planning-docs S3).
   *
   * Returns `false` when:
   *   - the session has not been created (`session` is null), OR
   *   - the session does not have an `updateTools` method.
   *
   * `main.ts` reads this via the public proxy (`hasLiveToolUpdate()`)
   * to gate the "tools now available" Notice — showing that Notice
   * with SDK 1.0.0 would lie because tools require reload.
   */
  private hasLiveToolUpdateInternal(): boolean {
    const session = this.session as unknown as
      | { updateTools?: unknown }
      | null;
    if (!session) return false;
    return typeof session.updateTools === "function";
  }

  hasLiveToolUpdate(): boolean {
    return this.hasLiveToolUpdateInternal();
  }

  /**
   * Phase 3 (MCP Readiness UX): apply the current merged tool list
   * (MCP + custom) to the live SDK session. See interface JSDoc for
   * the state-machine table (idle / streaming / pre-init / SDK 1.0.0
   * fallback).
   *
   * This method is safe to call at any time; it never throws. It is
   * called from `main.ts` on `McpStatusWatcher.onTransition` events
   * (per-server terminal state changes) — that surface is
   * intentionally not coalesced so tool availability tracks reality
   * inside the FR-004/005/007 2 s bound.
   */
  async applyToolListChange(): Promise<void> {
    // Disposed sessions can never accept further tool updates.
    if (this.disposed) return;
    // Pre-init or between-runtime: nothing to update. The next
    // createSession() reads `toolsForSession()` fresh, so lazy
    // conversations still pick up the new snapshot on activation.
    if (!this.session) return;
    // Turn-boundary queueing: while a stream is running, defer the
    // update to the drain in the streaming finally. Last-write-wins
    // — a boolean latch is enough because the tool list is always
    // rebuilt from the live `mcpTools()` snapshot at drain time.
    if (this.isStreamingFlag) {
      this.pendingToolUpdate = true;
      return;
    }
    // SDK 1.0.0 fallback: no live update primitive. Log once so the
    // no-op is observable in diagnostics, then return. FR-011
    // strict no-op.
    if (!this.hasLiveToolUpdateInternal()) {
      if (!this.loggedNoOpFallback) {
        this.loggedNoOpFallback = true;
        console.debug(
          "[AgentSession] applyToolListChange: SDK does not expose live tool update primitive; skipping (FR-011 fallback)",
        );
      }
      return;
    }
    const tools = this.toolsForSession();
    const session = this.session as unknown as {
      updateTools?: (tools: SdkTool[] | undefined) => unknown;
    };
    try {
      await Promise.resolve(session.updateTools?.(tools));
    } catch (e) {
      // Best-effort: an SDK error here must not crash the plugin or
      // corrupt session state. Log and move on — the next transition
      // will retry with a fresh snapshot.
      console.warn(
        "[AgentSession] applyToolListChange: SDK updateTools threw; leaving previous tool list in place",
        e,
      );
    }
  }

  /**
   * Test probe — returns the text most recently handed to
   * `session.sendAndWait` for the first send and the most recent
   * follow-up send. Lets unit tests assert preamble injection without
   * reaching into the SDK fake.
   */
  preambleProbe(): {
    firstSend: string | null;
    followupSend: string | null;
    firstSendArmed: boolean;
  } {
    return {
      firstSend: this.lastFirstSendText,
      followupSend: this.lastFollowupSendText,
      firstSendArmed: this.firstSendOfSession,
    };
  }

  async resetConversation(): Promise<void> {
    this.cancelAllPendingApprovals("Conversation was reset.");
    if (!this.client) {
      this.initPromise = null;
      this.session = null;
      return;
    }
    // Keep the running client; just swap the SDK session so model
    // context resets without paying the runtime-startup cost again.
    const oldSession = this.session;
    this.session = null;
    if (oldSession) {
      await safeCall(() => oldSession.disconnect?.());
    }
    if (!this.selectedModel) {
      this.selectedModel = await this.pickModel(this.client, this.preferredModelOverride ?? this.opts.preferredModel);
    }
    await this.awaitMcpReadinessGate();
    const fresh = await this.client.createSession({
      model: this.selectedModel,
      availableTools: ["builtin:*", "custom:*", "mcp:*"],
      streaming: true,
      tools: this.toolsForSession(),
      onPermissionRequest: (request: SdkPermissionRequest) =>
        this.handlePermission(request),
    });
    this.session = fresh;
    this.firstSendOfSession = true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // MCP Readiness UX Phase 2: clear the readiness-gate flag on
    // dispose so `isReadinessGateWaiting()` reflects the disposed
    // state truthfully even if an in-flight `awaitMcpReadinessGate`
    // is still parked in its `await`. The awaiting doInit() will
    // observe `disposed = true` immediately after and bail without
    // creating a session, so the finally-block still emits
    // `resolved` and resets the flag — but doing it here too makes
    // the observable state consistent from the moment dispose
    // returns, per plan Phase 2 spec §isReadinessGateWaiting.
    this.readinessGateWaiting = false;
    // MCP Readiness UX Phase 3: drop any pending tool-update latch
    // and stream flag so a post-dispose transition doesn't try to
    // drain into a dead session.
    this.pendingToolUpdate = false;
    this.isStreamingFlag = false;
    if (this.unsubCatalog) {
      try {
        this.unsubCatalog();
      } catch {
        /* listener unsubscribe must not throw */
      }
      this.unsubCatalog = null;
    }
    this.cancelAllPendingApprovals("Agent disposed.");
    await this.stopRuntime();
  }

  /**
   * Non-terminal shutdown: stop the SDK runtime and drop the session,
   * but keep the AgentSession reusable. Used by `setToken()` so the next
   * `init()` builds a fresh CopilotClient with the new token.
   *
   * Closes the dispose-during-init race the same way `dispose()` did.
   */
  private async stopRuntime(): Promise<void> {
    // Bump the epoch so any in-flight doInit() can detect that its
    // runtime is no longer wanted and bail out cleanly. See the
    // `initEpoch` field docs.
    this.initEpoch++;
    // If init is still in flight, wait briefly so it can either finish
    // (and we then tear it down) or fail (and stay null). This closes
    // the race where Obsidian unloads — or the token rotates — mid-init
    // and leaves a zombie copilot.exe behind.
    if (this.initPromise) {
      await raceWithTimeout(
        this.initPromise.catch(() => {
          /* swallow — we just want to wait for resolution */
        }),
        STOP_TIMEOUT_MS,
      ).catch(() => {
        /* timed out — fall through and tear down whatever exists */
      });
    }
    const session = this.session;
    const client = this.client;
    this.session = null;
    this.client = null;
    this.initPromise = null;
    this.selectedModel = undefined;
    this.deferredSession = false;

    if (session) {
      await raceWithTimeout(
        safeCall(() => session.disconnect?.()),
        STOP_TIMEOUT_MS,
      ).catch((e) =>
        console.warn("[AgentSession] session.disconnect timed out", e),
      );
    }
    if (client) {
      try {
        await raceWithTimeout(
          safeCall(() => client.stop?.()),
          STOP_TIMEOUT_MS,
        );
      } catch (e) {
        console.warn("[AgentSession] client.stop timed out, force stopping", e);
        try {
          await client.forceStop?.();
        } catch (e2) {
          console.warn("[AgentSession] client.forceStop failed", e2);
        }
      }
    }
  }

  async setToken(token: string | null): Promise<void> {
    if (this.disposed) {
      throw new Error("AgentSession disposed");
    }
    this.cancelAllPendingApprovals("Authentication changed.");
    // Always tear the runtime down first so the next init() picks up
    // the new token. If the token is unchanged we still rebuild — this
    // keeps the lifecycle simple and matches "reconnect" semantics.
    await this.stopRuntime();
    this.currentToken = token;
  }

  async reconnect(): Promise<string | undefined> {
    if (this.disposed) {
      throw new Error("AgentSession disposed");
    }
    // Force a fresh attempt — even if a previous init succeeded, the
    // caller (AuthController) wants to validate the current token.
    await this.stopRuntime();
    await this.init();
    return this.selectedModel;
  }

  // ---- internals ----

  private async doInit(): Promise<void> {
    const epoch = this.initEpoch;
    const sdk = await this.sdkLoader();
    if (this.disposed) throw new Error("AgentSession disposed during init");
    if (this.initEpoch !== epoch) {
      throw new Error("AgentSession runtime torn down during init");
    }
    const CopilotClient = sdk.CopilotClient;
    if (!CopilotClient) {
      throw new Error("@github/copilot-sdk does not export CopilotClient");
    }

    const client = new CopilotClient({
      gitHubToken: this.currentToken ?? "",
      useLoggedInUser: false,
      mode: "empty",
      baseDirectory: this.opts.baseDirectory,
      connection: { kind: "stdio", path: this.opts.cliPath },
      logLevel: this.opts.logLevel ?? "info",
    });

    // From this point on we own a live client. On any post-await disposal
    // OR epoch advance (token rotation / stopRuntime fired while we were
    // mid-init) we MUST tear it down ourselves — stopRuntime can't see
    // a client we haven't assigned to `this.client` yet.
    const bailIfStale = async (): Promise<void> => {
      if (!this.disposed && this.initEpoch === epoch) return;
      await safeCall(() => client.stop?.());
      throw new Error(
        this.disposed
          ? "AgentSession disposed during init"
          : "AgentSession runtime torn down during init",
      );
    };

    try {
      if (typeof client.start === "function") {
        await client.start();
        await bailIfStale();
      }
      if (typeof client.ping === "function") {
        await client.ping();
        await bailIfStale();
      }

      this.client = client;

      let model: string;
      try {
        model = await this.pickModel(
          client,
          this.preferredModelOverride ?? this.opts.preferredModel,
        );
      } catch (pickErr) {
        // v0.4 Phase 5 (S1): if a shared catalog is wired and currently
        // non-ready, DEFER createSession() instead of failing init.
        // The runtime stays alive; the catalog subscription added in
        // the constructor will fire `tryRecoverDeferred()` when the
        // catalog transitions to `ready` (user retry, token rotation,
        // or background refresh). Without a wired catalog there is no
        // recovery path, so the original error propagates.
        const catalog = this.opts.catalog;
        if (catalog && catalog.getState().kind !== "ready") {
          await bailIfStale();
          this.deferredSession = true;
          this.firstSendOfSession = true;
          return; // init resolves successfully in deferred state
        }
        throw pickErr;
      }
      await bailIfStale();
      this.selectedModel = model;

      await this.awaitMcpReadinessGate();
      const session = await client.createSession({
        model,
        availableTools: ["builtin:*", "custom:*", "mcp:*"],
        streaming: true,
        tools: this.toolsForSession(),
        onPermissionRequest: (request: SdkPermissionRequest) =>
          this.handlePermission(request),
      });
      if (this.disposed || this.initEpoch !== epoch) {
        await safeCall(() => session.disconnect?.());
        await safeCall(() => client.stop?.());
        // Also undo the `this.client = client` assignment above so
        // stopRuntime doesn't double-tear-down a client we already
        // stopped here. Guard the null in case a newer init() raced
        // ahead and assigned its own client.
        if (this.client === client) this.client = null;
        throw new Error(
          this.disposed
            ? "AgentSession disposed during init"
            : "AgentSession runtime torn down during init",
        );
      }
      this.session = session;
      this.firstSendOfSession = true;
    } catch (err) {
      // On any failure after the client was constructed, make sure we
      // don't leak the runtime process.
      if (this.client !== client) {
        await safeCall(() => client.stop?.());
      }
      throw err;
    }
  }

  /**
   * v0.4 Phase 5 (S1): create the SDK session for a session that
   * finished `doInit()` in deferred state. Idempotent and racy-safe:
   *  - Returns silently if not deferred, no client, already has a
   *    session, or disposed.
   *  - If an explicit `preferred` id is passed (e.g. from `swapModel`)
   *    it's used directly without consulting the catalog. Otherwise
   *    falls back to `pickModel()` (catalog-then-listModels-then-
   *    heuristic), which means catalog-`ready` notifications are
   *    sufficient to drive recovery without the user picking an id.
   *  - On any failure, leaves `deferredSession === true` so the next
   *    catalog notify can retry. We only flip the flag on success.
   *  - Race-safety: if the runtime is torn down or disposed during
   *    `createSession()`, we disconnect the half-built session and
   *    leave state untouched.
   */
  private async tryRecoverDeferred(preferred?: string): Promise<void> {
    if (!this.deferredSession || !this.client || this.session || this.disposed) {
      return;
    }
    const client = this.client;
    const epoch = this.initEpoch;
    let model: string;
    try {
      model = preferred ?? (await this.pickModel(
        client,
        this.preferredModelOverride ?? this.opts.preferredModel,
      ));
    } catch {
      // Catalog flipped non-ready between notify and now (or
      // listModels still failing). Stay deferred; the next catalog
      // notify will retry.
      return;
    }
    if (this.disposed || this.initEpoch !== epoch) return;
    let session: SdkSession;
    try {
      await this.awaitMcpReadinessGate();
      session = await client.createSession({
        model,
        availableTools: ["builtin:*", "custom:*", "mcp:*"],
        streaming: true,
        tools: this.toolsForSession(),
        onPermissionRequest: (request: SdkPermissionRequest) =>
          this.handlePermission(request),
      });
    } catch (e) {
      console.warn("[AgentSession] deferred createSession failed", e);
      return;
    }
    if (this.disposed || this.initEpoch !== epoch || this.session) {
      await safeCall(() => session.disconnect?.());
      return;
    }
    this.selectedModel = model;
    this.preferredModelOverride = model;
    this.session = session;
    this.firstSendOfSession = true;
    this.deferredSession = false;
  }

  private async pickModel(
    client: SdkClient,
    preferred: string | undefined,
  ): Promise<string> {
    if (preferred) return preferred;
    // v0.4 Phase 2: when a shared catalog is wired in and ready,
    // resolve from its cached chat-capable list to avoid a duplicate
    // listModels() round-trip per session creation. Any non-ready
    // state (loading, empty, error, or catalog absent) falls through
    // to the v0.3 path so phase shippability is preserved.
    const catalog = this.opts.catalog;
    if (catalog) {
      const state = catalog.getState();
      if (state.kind === "ready") {
        const resolved = resolveHeuristicModelId(state.chatModels);
        if (resolved !== null) return resolved;
        // chatModels was non-empty per the `ready` invariant but the
        // resolver returned null (every record lacked a usable id) —
        // fall through to listModels() rather than hard-failing here.
      }
    }
    if (typeof client.listModels !== "function") {
      return "gpt-4.1";
    }
    let models: SdkModelInfo[];
    try {
      models = (await client.listModels()) as SdkModelInfo[];
    } catch (e) {
      throw new Error(
        `[AgentSession] client.listModels failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    const resolved = resolveHeuristicModelId(models);
    if (resolved === null) {
      throw new Error(
        "[AgentSession] No Copilot models available for this account.",
      );
    }
    return resolved;
  }

  private async handlePermission(
    request: SdkPermissionRequest,
  ): Promise<SdkPermissionResult> {
    // Permission requests are clear evidence of model activity; reset
    // the streaming idle watchdog so a long approval prompt doesn't
    // trip the timeout.
    this.bumpIdleTimer?.();
    const normalised: PermissionRequest = {
      kind: request.kind ?? "(unknown)",
      toolName: request.toolName,
      raw: request,
    };
    const toolCallId =
      request.toolCallId ?? request.id ?? `tc${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const source = classifyToolSource(
      request.kind,
      request.toolName,
      this.customToolNames,
    );
    const argsPreview = previewArgs(request, source);

    // Phase 6 path: SafetyPolicy decides.
    if (this.opts.safety) {
      return this.handlePermissionViaSafetyPolicy(
        request,
        normalised,
        toolCallId,
        source,
        argsPreview,
      );
    }

    // Legacy Phase-2 fallback path (used by tests that don't wire SafetyPolicy).
    const decision = await this.opts.decider(normalised);
    if (decision.kind === "reject") {
      const call: AssistantToolCall = {
        id: toolCallId,
        kind: normalised.kind,
        name: normalised.toolName,
        source,
        outcome: "denied",
        detail: decision.feedback,
        argsPreview,
      };
      this.toolCallsThisTurn.push(call);
      this.currentStreamPush?.({ type: "tool_call_start", toolCall: call });
      this.currentStreamPush?.({
        type: "tool_call_complete",
        id: toolCallId,
        outcome: "denied",
        errorMessage: decision.feedback,
      });
      return { kind: "reject", feedback: decision.feedback ?? "Denied." };
    }
    const call: AssistantToolCall = {
      id: toolCallId,
      kind: normalised.kind,
      name: normalised.toolName,
      source,
      outcome: "approved",
      argsPreview,
    };
    this.toolCallsThisTurn.push(call);
    return { kind: decision.kind };
  }

  /**
   * Phase 6 permission flow. Per design critique:
   *   - Always return `approve-once` to the SDK (never `approve-for-session`)
   *     so subsequent calls re-enter this function and re-consult our
   *     policy; "approve for session" is implemented via our own
   *     `SafetyState` grants.
   *   - On `require-approval`, push an `approval_prompt` stream event,
   *     await user click via `pendingApprovals` deferred, then map the
   *     choice to an SDK result.
   *   - On cleanup, `cancelAllPendingApprovals` resolves every deferred
   *     with `{ kind: "reject" }` so the SDK never hangs.
   */
  private async handlePermissionViaSafetyPolicy(
    request: SdkPermissionRequest,
    normalised: PermissionRequest,
    toolCallId: string,
    source: "custom" | "mcp" | "builtin",
    argsPreview: string | undefined,
  ): Promise<SdkPermissionResult> {
    // Short-circuit if this toolCallId was already resolved earlier in
    // this session. The SDK can re-emit permissionRequested for an
    // already-handled call; re-prompting would regress the UI from
    // completed back to pending_approval and the new prompt would never
    // be resolved.
    const safety = this.opts.safety!;
    const currentMcpCacheKey =
      source === "mcp" ? this.getCurrentMcpCacheKey(request, safety) : undefined;
    const prior = this.resolvedApprovals.get(toolCallId);
    if (prior) {
      if (prior.mcpCacheKey !== currentMcpCacheKey) {
        this.resolvedApprovals.delete(toolCallId);
      } else {
        // eslint-disable-next-line no-console -- documented redaction seam: approval short-circuit telemetry
        console.debug(redactSensitive(`[copilot-agent] permission re-ask short-circuited id=${toolCallId} priorChoice=${prior.kind}`));
        if (prior.kind === "reject" || prior.kind === "cancelled") {
          return { kind: "reject", feedback: prior.reason ?? "Rejected." };
        }
        return { kind: "approve-once" };
      }
    }

    const config = safety.config();
    const input = this.buildSafetyInput(request, safety);
    const decision = decideSafety(input, config, safety.state);

    if (decision.decision === "rejected") {
      this.resolvedApprovals.set(toolCallId, {
        kind: "reject",
        reason: decision.reason,
        mcpCacheKey: currentMcpCacheKey,
      });
      return this.recordRejection(
        toolCallId,
        normalised,
        source,
        argsPreview,
        decision,
      );
    }

    if (decision.decision === "auto-apply") {
      // Push an approved entry so the chat shows the tool call ran
      // (without prompting). The SDK will fire tool.execution_* events
      // next; the stream handler will upsert by id.
      const call: AssistantToolCall = {
        id: toolCallId,
        kind: normalised.kind,
        name: normalised.toolName,
        source,
        outcome: "approved",
        detail: decision.reason,
        argsPreview,
      };
      this.upsertTurnToolCall(call);
      this.currentStreamPush?.({ type: "tool_call_start", toolCall: call });
      this.resolvedApprovals.set(toolCallId, {
        kind: "approve-once",
        mcpCacheKey: currentMcpCacheKey,
      });
      return { kind: "approve-once" };
    }

    // require-approval: surface a prompt in the chat and await user click.
    const summary = buildApprovalSummary(request, input);
    const detail = buildApprovalDetail(request);
    const canOfferSession = request.canOfferSessionApproval !== false;
    const pendingCall: AssistantToolCall = {
      id: toolCallId,
      kind: normalised.kind,
      name: normalised.toolName,
      source,
      outcome: "pending_approval",
      argsPreview,
      approval: { summary, detail, canOfferSession },
    };
    this.upsertTurnToolCall(pendingCall);

    // If no stream is active (e.g. sendMessage non-streaming path) we
    // have no UI to surface the prompt — fail closed.
    if (!this.currentStreamPush) {
      return { kind: "reject", feedback: "No UI available to confirm tool call." };
    }
    const deferred = makeDeferred<ApprovalChoice>();
    this.pendingApprovals.set(toolCallId, deferred);
    if (input.source === "mcp" && input.mcpServerId) {
      this.registerPendingMcpApproval(input.mcpServerId, toolCallId, {
        deferred,
        toolName: input.mcpToolName,
        trustEpoch: input.mcpTrustEpoch,
      });
    }
    this.currentStreamPush({ type: "approval_prompt", toolCall: pendingCall });
    let choice: ApprovalChoice;
    try {
      choice = await deferred.promise;
    } finally {
      this.pendingApprovals.delete(toolCallId);
      if (input.source === "mcp" && input.mcpServerId) {
        this.unregisterPendingMcpApproval(input.mcpServerId, toolCallId);
      }
    }
    this.resolvedApprovals.set(toolCallId, {
      ...choice,
      mcpCacheKey: currentMcpCacheKey,
    });

    // Always emit `approval_resolved` so the UI can transition the
    // pending block to its post-decision state.
    this.currentStreamPush?.({
      type: "approval_resolved",
      id: toolCallId,
      choice,
    });

    if (choice.kind === "cancelled") {
      const reason = choice.reason ?? "Cancelled.";
      return this.recordCancellation(toolCallId, normalised, source, argsPreview, reason);
    }

    if (choice.kind === "reject") {
      const reason = choice.reason ?? "Rejected by user.";
      return this.recordRejection(
        toolCallId,
        normalised,
        source,
        argsPreview,
        { decision: "rejected", reason },
      );
    }

    if (input.source === "mcp") {
      const latestInput = this.buildSafetyInput(request, safety);
      if (
        !latestInput.mcpServerId ||
        !latestInput.mcpToolName ||
        !latestInput.mcpTrustEpoch ||
        latestInput.mcpServerId !== input.mcpServerId ||
        latestInput.mcpToolName !== input.mcpToolName ||
        latestInput.mcpTrustEpoch !== input.mcpTrustEpoch
      ) {
        const reason =
          "MCP server metadata changed before dispatch; approval is no longer valid.";
        this.resolvedApprovals.set(toolCallId, {
          kind: "reject",
          reason,
          mcpCacheKey: this.getCurrentMcpCacheKey(request, safety),
        });
        return this.recordRejection(toolCallId, normalised, source, argsPreview, {
          decision: "rejected",
          reason,
        });
      }
    }

    if (choice.kind === "approve-for-session") {
      // Apply the grant in our local SafetyState. We narrow the grant
      // to the same scope SafetyPolicy considered: vault writes ->
      // grantVault; per-server for MCP; per-kind/per-tool for builtin.
      switch (input.source) {
        case "vault":
          safety.state.grantVault();
          break;
        case "extra-vault":
          if (input.extraVaultRoot)
            safety.state.grantExtraVault(input.extraVaultRoot);
          break;
        case "mcp":
          if (input.mcpServerId && input.mcpToolName && input.mcpTrustEpoch) {
            safety.state.grantMcp(
              input.mcpServerId,
              input.mcpToolName,
              input.mcpTrustEpoch,
            );
          }
          break;
        case "builtin":
          if (input.toolName) safety.state.grantBuiltin(input.toolName);
          break;
      }
    }

    // Both approve-once and approve-for-session map to SDK approve-once
    // (we manage session grants ourselves to keep policy reentrant).
    return { kind: "approve-once" };
  }

  /**
   * Build the SafetyPolicyInput from an SDK permission request. Source
   * classification rules:
   *   - Our registered write tools (kind=custom-tool, toolName in WRITE_TOOL_NAMES) → `vault`
   *   - MCP (kind=mcp) → `mcp`, toolName=serverName
   *   - Everything else → `builtin`, toolName=kind (or args toolName for custom-tool)
   */
  private buildSafetyInput(
    request: SdkPermissionRequest,
    safety: NonNullable<AgentSessionOptions["safety"]>,
  ): SafetyPolicyInput {
    const kind = request.kind ?? "";
    const toolName = request.toolName;

    if (kind === "custom-tool" && toolName && isVaultWriteToolName(toolName)) {
      const vaultPath =
        safety.extractVaultPath?.(request) ??
        (typeof request.args?.path === "string"
          ? (request.args.path as string)
          : undefined);
      return {
        source: "vault",
        toolName,
        vaultRelativePath: vaultPath,
      };
    }

    if (kind === "mcp") {
      const metadata = safety.getMcpToolSourceMetadata?.(request);
      return {
        source: "mcp",
        toolName: metadata?.toolName ?? toolName ?? request.serverName ?? "(unknown)",
        mcpServerId: metadata?.stableServerId,
        mcpToolName: metadata?.toolName,
        mcpTrustEpoch: metadata?.trustEpoch,
      };
    }

    // Built-in. Key by SDK kind for shell/url/memory/hook/read/write,
    // or by tool name for unregistered custom-tool kinds.
    let key = kind;
    if (kind === "custom-tool" && toolName) key = toolName;
    return { source: "builtin", toolName: key };
  }

  private getCurrentMcpCacheKey(
    request: SdkPermissionRequest,
    safety: NonNullable<AgentSessionOptions["safety"]>,
  ): string | undefined {
    const metadata = safety.getMcpToolSourceMetadata?.(request);
    if (!metadata) return undefined;
    return `${metadata.stableServerId}\u0000${metadata.toolName}\u0000${metadata.trustEpoch}`;
  }

  private recordRejection(
    toolCallId: string,
    normalised: PermissionRequest,
    source: "custom" | "mcp" | "builtin",
    argsPreview: string | undefined,
    decision: { decision: "rejected"; reason: string } | SafetyDecisionResult,
  ): SdkPermissionResult {
    const reason = decision.reason;
    const call: AssistantToolCall = {
      id: toolCallId,
      kind: normalised.kind,
      name: normalised.toolName,
      source,
      outcome: "denied",
      detail: reason,
      argsPreview,
    };
    this.toolCallsThisTurn.push(call);
    this.currentStreamPush?.({ type: "tool_call_start", toolCall: call });
    this.currentStreamPush?.({
      type: "tool_call_complete",
      id: toolCallId,
      outcome: "denied",
      errorMessage: reason,
    });
    return { kind: "reject", feedback: reason };
  }

  private recordCancellation(
    toolCallId: string,
    normalised: PermissionRequest,
    source: "custom" | "mcp" | "builtin",
    argsPreview: string | undefined,
    reason: string,
  ): SdkPermissionResult {
    const call: AssistantToolCall = {
      id: toolCallId,
      kind: normalised.kind,
      name: normalised.toolName,
      source,
      outcome: "cancelled",
      detail: reason,
      argsPreview,
    };
    this.toolCallsThisTurn.push(call);
    this.currentStreamPush?.({ type: "tool_call_start", toolCall: call });
    this.currentStreamPush?.({
      type: "tool_call_complete",
      id: toolCallId,
      outcome: "cancelled",
      errorMessage: reason,
    });
    return { kind: "reject", feedback: reason };
  }

  resolveApproval(toolCallId: string, choice: ApprovalChoice): void {
    const deferred = this.pendingApprovals.get(toolCallId);
    if (!deferred) return;
    this.pendingApprovals.delete(toolCallId);
    deferred.resolve(choice);
  }

  /**
   * Resolve every pending approval with a reject so the SDK never
   * hangs waiting for a user that cannot respond. Called on:
   *   - cancelCurrent (user clicked Stop)
   *   - stream generator early-close / finally
   *   - resetConversation (Clear conversation)
   *   - setToken / reconnect (token rotation)
   *   - dispose (plugin unload)
   */
  /**
   * Public probe: does this session currently have any tool-approval prompts
   * awaiting user response? Consumed by the v0.4 model-picker confirmation
   * copy (`buildSwapConfirmCopy`) so the user knows the pending approvals
   * will be cancelled by `swapModel()` if they confirm the switch.
   */
  public hasPendingApprovals(): boolean {
    return this.pendingApprovals.size > 0;
  }

  public cancelPendingMcpApprovalsForServer(serverId: string, reason = "MCP server disconnected."): void {
    this.clearResolvedMcpApprovalsForServer(serverId);
    const pendingForServer = this.pendingMcpApprovalsByServer.get(serverId);
    if (!pendingForServer) return;
    const cancelled: ApprovalChoice = { kind: "cancelled", reason };
    for (const [toolCallId, pending] of [...pendingForServer]) {
      pending.deferred.resolve(cancelled);
      this.pendingApprovals.delete(toolCallId);
      pendingForServer.delete(toolCallId);
    }
    if (pendingForServer.size === 0) this.pendingMcpApprovalsByServer.delete(serverId);
  }

  public cancelMcpCallsForServer(serverId: string, reason = "MCP server disconnected."): void {
    this.clearResolvedMcpApprovalsForServer(serverId);
    const activeForServer = this.activeMcpCallsByServer.get(serverId);
    if (!activeForServer) return;
    for (const toolCallId of [...activeForServer]) {
      this.lifecycleCancelledMcpCallIds.add(toolCallId);
      const existing = this.toolCallsThisTurn.find((call) => call.id === toolCallId);
      if (existing) {
        existing.outcome = "cancelled";
        existing.detail = reason;
        existing.approval = undefined;
      }
      this.currentStreamPush?.({
        type: "tool_call_complete",
        id: toolCallId,
        outcome: "cancelled",
        errorMessage: reason,
      });
      activeForServer.delete(toolCallId);
    }
    if (activeForServer.size === 0) this.activeMcpCallsByServer.delete(serverId);
  }

  private cancelAllPendingApprovals(reason: string): void {
    if (this.pendingApprovals.size === 0) return;
    const reject: ApprovalChoice = { kind: "reject", reason };
    for (const [, deferred] of this.pendingApprovals) {
      deferred.resolve(reject);
    }
    this.pendingApprovals.clear();
    this.pendingMcpApprovalsByServer.clear();
  }

  private registerPendingMcpApproval(
    serverId: string,
    toolCallId: string,
    pending: PendingMcpApproval,
  ): void {
    let pendingForServer = this.pendingMcpApprovalsByServer.get(serverId);
    if (!pendingForServer) {
      pendingForServer = new Map();
      this.pendingMcpApprovalsByServer.set(serverId, pendingForServer);
    }
    pendingForServer.set(toolCallId, pending);
  }

  private registerActiveMcpCall(serverId: string, toolCallId: string): void {
    let activeForServer = this.activeMcpCallsByServer.get(serverId);
    if (!activeForServer) {
      activeForServer = new Set();
      this.activeMcpCallsByServer.set(serverId, activeForServer);
    }
    activeForServer.add(toolCallId);
  }

  private unregisterActiveMcpCall(toolCallId: string): void {
    for (const [serverId, activeForServer] of this.activeMcpCallsByServer) {
      activeForServer.delete(toolCallId);
      if (activeForServer.size === 0) this.activeMcpCallsByServer.delete(serverId);
    }
    this.lifecycleCancelledMcpCallIds.delete(toolCallId);
  }

  private unregisterPendingMcpApproval(serverId: string, toolCallId: string): void {
    const pendingForServer = this.pendingMcpApprovalsByServer.get(serverId);
    if (!pendingForServer) return;
    pendingForServer.delete(toolCallId);
    if (pendingForServer.size === 0) this.pendingMcpApprovalsByServer.delete(serverId);
  }

  private clearResolvedMcpApprovalsForServer(serverId: string): void {
    const prefix = `${serverId}\u0000`;
    for (const [toolCallId, cached] of this.resolvedApprovals) {
      if (cached.mcpCacheKey?.startsWith(prefix)) {
        this.resolvedApprovals.delete(toolCallId);
      }
    }
  }
}

// ---- helpers ----

/**
 * Classify the source of a tool call for the chat UI. We can't read
 * a single SDK field for this, so we infer from a few signals:
 *   - If the tool name matches one we registered via `opts.tools`, it
 *     is a custom (vault) tool.
 *   - `request.kind === "mcp"` indicates an MCP tool.
 *   - Everything else is a runtime built-in (`shell`, `web_fetch`, …).
 */
export function classifyToolSource(
  kind: string | undefined,
  toolName: string | undefined,
  customNames: Set<string>,
): "custom" | "mcp" | "builtin" {
  if (toolName && parseSyntheticId(toolName)) return "mcp";
  // Strongest non-MCP signal: name matches a vault tool we registered.
  if (toolName && customNames.has(toolName)) return "custom";
  // SDK kind hints. `custom-tool` is the wire shape for user-defined
  // tools we may have registered under an alias or via overrides.
  if (kind === "custom-tool") return "custom";
  if (kind === "mcp") return "mcp";
  return "builtin";
}

/** Kind-aware args preview for the UI tool-call block. */
function previewArgs(
  request: SdkPermissionRequest,
  source?: "custom" | "mcp" | "builtin",
): string | undefined {
  switch (request.kind) {
    case "shell":
      return request.fullCommandText
        ? truncate(request.fullCommandText, 200)
        : undefined;
    case "url":
      return request.url ? truncate(request.url, 200) : undefined;
    case "read":
      return request.path ? `read: ${truncate(request.path, 180)}` : undefined;
    case "write":
      return request.fileName
        ? `write: ${truncate(request.fileName, 180)}`
        : undefined;
    case "memory":
      return request.fact ? truncate(request.fact, 200) : undefined;
    case "custom-tool":
    case "mcp":
      return source === "mcp"
        ? stringifyMcpArgsForPreview(request.args)
        : stringifyArgsForPreview(request.args);
    default: {
      // Legacy fallback used by tests that pass `arguments` directly.
      const raw = (request as { arguments?: unknown }).arguments;
      return source === "mcp"
        ? stringifyMcpArgsForPreview(raw)
        : stringifyArgsForPreview(raw);
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Build a short human-readable summary line for the approval prompt header. */
function buildApprovalSummary(
  request: SdkPermissionRequest,
  input: SafetyPolicyInput,
): string {
  if (input.source === "vault" && input.toolName && input.vaultRelativePath) {
    return `${input.toolName} ${input.vaultRelativePath}`;
  }
  switch (request.kind) {
    case "shell":
      return `Run shell command`;
    case "url":
      return `Fetch URL`;
    case "write":
      return `Write ${request.fileName ?? "(file)"}`;
    case "read":
      return `Read ${request.path ?? "(path)"}`;
    case "memory":
      return `Update memory`;
    case "mcp":
      return formatMcpApprovalText(
        `MCP tool ${input.mcpToolName ?? request.toolName ?? ""} on ${
          input.mcpServerId ?? request.serverName ?? "unknown server"
        }`,
      );
    case "custom-tool":
      return `${request.toolName ?? "custom tool"}`;
    default:
      return request.kind ?? "Tool call";
  }
}

/** Build the long-form detail body (e.g. full shell command, URL, args JSON). */
function buildApprovalDetail(
  request: SdkPermissionRequest,
): string | undefined {
  switch (request.kind) {
    case "shell":
      return request.fullCommandText;
    case "url":
      return request.url;
    case "write":
      return request.fileName;
    case "read":
      return request.path;
    case "memory":
      return request.fact;
    case "mcp":
      return request.args
        ? formatMcpApprovalText(redactSensitive(safeJson(request.args)))
        : undefined;
    case "custom-tool":
      return request.args ? safeJson(request.args) : undefined;
    default:
      return undefined;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Minimal deferred — resolve only (never rejects, simplifying error paths). */
function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Shared truncation helper for both permission-request and execution_start arg previews. */
function stringifyArgsForPreview(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const s = JSON.stringify(raw);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(raw);
  }
}

function stringifyMcpArgsForPreview(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  return formatMcpApprovalText(redactSensitive(safeJson(raw)));
}

function sanitizeMcpMaybe(
  source: "custom" | "mcp" | "builtin" | undefined,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (source !== "mcp") return value;
  return normalizeMcpResult(value).content;
}

function extractText(resp: unknown): string | undefined {
  if (typeof resp === "string") return resp;
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    const data = r.data as Record<string, unknown> | undefined;
    if (data && typeof data.content === "string") return data.content;
    if (typeof r.content === "string") return r.content;
    if (typeof r.text === "string") return r.text;
    if (typeof r.message === "string") return r.message;
    const msg = r.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.content === "string") return msg.content;
  }
  return undefined;
}

async function safeCall<T>(
  fn: () => T | Promise<T> | undefined,
): Promise<T | undefined> {
  try {
    const v = fn();
    return await Promise.resolve(v);
  } catch (e) {
    console.warn("[AgentSession] cleanup call threw", e);
    return undefined;
  }
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    const msg = err.message.toLowerCase();
    if (msg.includes("abort") || msg.includes("cancel")) return true;
  }
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /abort|cancel/i.test(code)) return true;
  }
  return false;
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function defaultSdkLoader(): Promise<SdkModule> {
  const mod = (await import("@github/copilot-sdk")) as unknown as SdkModule;
  return mod;
}

// ---- minimal structural SDK shapes (kept local for testability) ----

export interface SdkModule {
  CopilotClient: new (opts: unknown) => SdkClient;
}

export interface SdkModelInfo {
  id?: string;
  policy?: { state?: string };
}

export interface SdkClient {
  start?: () => Promise<void> | void;
  ping?: () => Promise<unknown> | unknown;
  listModels?: () => Promise<SdkModelInfo[]>;
  createSession: (opts: SdkSessionOptions) => Promise<SdkSession>;
  stop?: () => Promise<unknown>;
  forceStop?: () => Promise<void>;
}

export interface SdkSessionOptions {
  model: string;
  availableTools?: string[] | unknown;
  /** Phase 4: opt in to streaming delta events. */
  streaming?: boolean;
  /** Phase 5: custom tools registered with the session. */
  tools?: SdkTool[];
  onPermissionRequest: (
    request: SdkPermissionRequest,
    invocation?: unknown,
  ) => Promise<SdkPermissionResult> | SdkPermissionResult;
}

/** Subset of the SDK's session event we care about for streaming. */
export interface SdkMessageDeltaEvent {
  type: "assistant.message_delta";
  data: { deltaContent: string; messageId?: string };
}

/** Phase 5: tool lifecycle events. */
export interface SdkToolExecutionStartEvent {
  type: "tool.execution_start";
  data: {
    toolCallId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    mcpServerName?: string;
    mcpToolName?: string;
  };
}

export interface SdkToolExecutionCompleteEvent {
  type: "tool.execution_complete";
  data: {
    toolCallId: string;
    success: boolean;
    result?: { content?: string; detailedContent?: string };
    error?: { code?: string; message: string };
  };
}

export interface SdkSession {
  sendAndWait: (prompt: string, timeout?: number) => Promise<unknown>;
  abort?: () => Promise<unknown> | unknown;
  disconnect?: () => Promise<unknown> | unknown;
  /**
   * v0.4 FR-005: swap the active model on this SDK session in place,
   * preserving conversation history. Applies to subsequent messages.
   * The SDK guarantees the new model id is validated against the
   * runtime's installed model list; rejection throws.
   */
  setModel?: (modelId: string, options?: unknown) => Promise<unknown> | unknown;
  /**
   * Phase 4/5: subscribe to a specific event type. The SDK returns an
   * unsubscribe function. Modelled structurally so tests can stub it.
   */
  on?: ((
    eventType: "assistant.message_delta",
    handler: (event: SdkMessageDeltaEvent) => void,
  ) => () => void) &
    ((
      eventType: "tool.execution_start",
      handler: (event: SdkToolExecutionStartEvent) => void,
    ) => () => void) &
    ((
      eventType: "tool.execution_complete",
      handler: (event: SdkToolExecutionCompleteEvent) => void,
    ) => () => void);
}

export interface SdkPermissionRequest {
  id?: string;
  /** SDK-canonical correlation id; used as our chat-block id when present. */
  toolCallId?: string;
  kind?: string;
  toolName?: string;
  /** Custom-tool / MCP arguments. */
  args?: Record<string, unknown>;
  /** Built-in `shell` request — full text to execute. */
  fullCommandText?: string;
  /** Built-in `write` request — target file (CLI-relative). */
  fileName?: string;
  /** Built-in `read` request — target path. */
  path?: string;
  /** Built-in `url` request — target URL. */
  url?: string;
  /** Built-in `memory` request — fact being stored / voted. */
  fact?: string;
  /** MCP request — server name. */
  serverName?: string;
  /** Whether the SDK considers session approval valid for this request. */
  canOfferSessionApproval?: boolean;
}

export type SdkPermissionResult =
  | { kind: "approve-once" }
  | { kind: "approve-for-session" }
  | { kind: "reject"; feedback: string };
